const { successResp, failureResp } = require('../utils/response');
const CouponModel = require('../models/coupons');
const UserCoupons = require('../models/userCoupons')
const sequelize = require('../config/database');
const Sequelize = require('sequelize');
const UserWallet = require('../models/userWallet');
const WalletTransactionModel = require('../models/walletTransactions');
const SpinModel = require('../models/spins'); // Ensure the Spin model is imported


async function getCoupons(req, res, next) {
    let coupons = await CouponModel.findAll({
        attributes: [
            'id', 
            'coupon_name', 
            'price', 
            'spin_days', 
            [Sequelize.literal('max_prize_amount'), 'daily_reward']
        ],
        where: { deleted_at: null }
    });
    if(!coupons) {
        return failureResp(res, "No coupons found", 404);
    }
    return successResp(res, "Coupon Data", 200,coupons);
}

async function buyCoupon(req, res, next) {
    let userId = req.user.id;
    let couponId = req.body.coupon_id;


    const CouponData=await CouponModel.findOne({where:{id:couponId,deleted_at : null}});
    if(!CouponData) {
        return failureResp(res, "Coupon not found", 404);
    }
    const results = await sequelize.query(`
        SELECT c.id, c.coupon_name,c.price,
        c.spin_days
        FROM coupons c
        JOIN user_coupons uc ON c.id = uc.coupon_id
         WHERE uc.user_id = :userId
          AND uc.coupon_id = :couponId
          AND uc.deleted_at IS NULL
          AND c.deleted_at IS NULL
          AND DATE_ADD(uc.created_at, INTERVAL c.spin_days DAY) >= NOW()
        LIMIT 1;
    `, {
        replacements: { userId, couponId },
        type: Sequelize.QueryTypes.SELECT
    });
    
    if (results && results.length > 0) {
        return failureResp(res, "Coupon already purchased", 409,results);
    }

    UserAmount=await UserWallet.findOne({where:{user_id:userId}});
    if(!UserAmount) {
        return failureResp(res, "User wallet not found", 404);
    }
    if(UserAmount.avl_amount < CouponData.price) {
        return failureResp(res, "Insufficient balance", 400);
    }
    let userCouponData = {
        user_id: userId,
        coupon_id: couponId,
        created_at: new Date(),
        updated_at: new Date()
    };
    let coupon_data=await UserCoupons.create(userCouponData);   
    if(!coupon_data) {
        return failureResp(res, "Coupon purchase failed", 500);
    }

    let transactionData = {
        user_wallet_id: UserAmount.id,
        transaction_type: 'debit',
        transaction_amount: CouponData.price,
        admin_wallets_id: null,
        type: 'debit',
        description: `Coupon purchase for coupon ID ${couponId}`,
        status: 'approved',
        created_at: new Date(),
        updated_at: new Date()
    };
    let transaction=await WalletTransactionModel.create(transactionData);
    if(!transaction) {
        return failureResp(res, "Transaction failed", 500);
    }
    UserAmount.avl_amount = UserAmount.avl_amount - CouponData.price;
    await UserAmount.save();
    return successResp(res, "Coupon purchased successfully", 200);
}

async function redeemCoupon(req, res, next) {
    const t = await sequelize.transaction();
    try {
        let userId = req.user.id;
        let userCouponId = req.body.user_coupon_id;

        const results = await sequelize.query(`
            SELECT c.id, c.coupon_name, c.max_prize_amount, c.min_prize_amount , c.spin_days, 
            uc.created_at AS purchase_date, 
            IF(DATE_ADD(uc.created_at, INTERVAL c.spin_days DAY) < NOW(), 1, 0) as is_coupon_expires
            FROM coupons c
            JOIN user_coupons uc ON c.id = uc.coupon_id
            WHERE uc.id = :userCouponId
            AND uc.deleted_at IS NULL
            AND c.deleted_at IS NULL
            LIMIT 1;
        `, {
            replacements: { userCouponId },
            type: Sequelize.QueryTypes.SELECT,
            transaction: t
        });

        if (!results || results.length == 0) {
            await t.rollback();
            return failureResp(res, "Coupon Not found.", 404, results);
        }

        let couponData = results[0];

        if (couponData.is_coupon_expires == 1) {
            await t.rollback();
            return failureResp(res, "Coupon already expired.", 409, results);
        }

        let minPrize = couponData.min_prize_amount;
        let maxPrize = couponData.max_prize_amount;
        let prizeAmount = Math.floor(Math.random() * (maxPrize - minPrize + 1)) + minPrize;

        let userWallet = await UserWallet.findOne({ where: { user_id: userId }, transaction: t });
        if (!userWallet) {
            await t.rollback();
            return failureResp(res, "User wallet not found", 404);
        }

        // Save spin
        let spinData = {
            user_coupon_id: userCouponId,
            prize_amount: prizeAmount,
            created_at: new Date(),
            updated_at: new Date()
        };

        let spinRecord = await SpinModel.create(spinData, { transaction: t });
        if (!spinRecord) {
            await t.rollback();
            return failureResp(res, "Failed to save spin data", 500);
        }

        // Save wallet transaction
        let transactionData = {
            user_wallet_id: userWallet.id,
            type: 'credit',
            transaction_amount: prizeAmount,
            description: `Coupon redeemed for coupon ID ${couponData.id}`,
            status: 'approved',
            created_at: new Date(),
            updated_at: new Date()
        };

        let transaction = await WalletTransactionModel.create(transactionData, { transaction: t });
        if (!transaction) {
            await t.rollback();
            return failureResp(res, "Transaction failed", 500);
        }

        // Update amount in user wallet
        userWallet.avl_amount += prizeAmount;
        await userWallet.save({ transaction: t });

        await t.commit();
        return successResp(res, "Coupon redeemed successfully", 200);
    } catch (error) {
        await t.rollback();
        return failureResp(res, "An error occurred while redeeming the coupon", 500, error.message);
    }
}

async function addCoupon(req, res, next) {
    const adminUser = req.user;
    if (adminUser.role !== 'admin') {
        return failureResp(res, "Unauthorized access.", 403);
    }

    let couponData = req.body;
    if(!couponData.coupon_name || !couponData.price || !couponData.spin_days || !couponData.max_prize_amount || !couponData.min_prize_amount) {
        return failureResp(res, "Coupon name, price, spin days, max_prize_amount and min_prize_amount are required", 400);
    }

    couponData.created_at = new Date();
    couponData.updated_at = new Date();

    let coupon = await CouponModel.create(couponData);
    if(!coupon) {
        return failureResp(res, "Failed to add coupon", 500);
    }
    return successResp(res, "Coupon added successfully", 200, coupon);
}

async function deleteCoupon(req, res, next) {
    const adminUser = req.user;
    if (adminUser.role !== 'admin') {
        return failureResp(res, "Unauthorized access.", 403);
    }

    let couponId = req.params.id;
    let coupon = await CouponModel.findOne({where:{id:couponId}});
    if(!coupon) {
        return failureResp(res, "Coupon not found", 404);
    }
    coupon.deleted_at = new Date();
    await coupon.save();
    return successResp(res, "Coupon deleted successfully", 200);
}

module.exports = {
    getCoupons,
    buyCoupon,
    redeemCoupon,
    addCoupon,
    deleteCoupon

}