const UserModel = require('../models/user');
const UserWallet = require('../models/userWallet');
const AdminWallets = require('../models/adminWallets');
const userAccountModel = require('../models/userAccounts');
const { successResp, failureResp } = require('../utils/response');
const Sequelize = require('sequelize');
const sequelize = require('../config/database');
const WalletTransactions = require('../models/walletTransactions');
const saltRounds = parseInt(process.env.SALT_ROUNDS || '10', 10);
const bcrypt = require('bcrypt');

async function getUserProfile(req, res, next) {

    const userId = req.user.id; // Assuming you have user ID in req.user after authentication
    let user = await UserModel.findOne({ where: { id: userId }, attributes: ['username', 'first_name', 'last_name'] });

    if (!user) {
        return successResp(res, "User not found.", 200, { user: {}, active_coupons: 0 });
    } else {
        user = user.toJSON();
    }

    const activeCoupons = await sequelize.query(`
        SELECT 
            c.id AS coupon_id,
            c.coupon_name,
            c.price,
            uc.id AS user_coupon_id,
            uc.created_at AS purchase_date
        FROM coupons c
        JOIN user_coupons uc ON c.id = uc.coupon_id
        WHERE uc.user_id = :userId 
          AND uc.deleted_at IS NULL 
          AND c.deleted_at IS NULL
          AND DATE_ADD(uc.created_at, INTERVAL c.spin_days DAY) >= NOW()
    `, {
        replacements: { userId: req.user.id },
        type: sequelize.QueryTypes.SELECT
    });

    const totalActiveCoupons = activeCoupons.length;

    const userWallet = await UserWallet.findOne({ where: { user_id: userId, deleted_at: null }, attributes: ['avl_amount','id'] });

    let pendingDebitSum = 0;
    if (userWallet) {
        pendingDebitSum = await WalletTransactions.sum('transaction_amount', {
            where: {
                user_wallet_id: userWallet.id,
                status: 'pending',
                transaction_purpose: 'wallet_debit'
            }
        });
    }

    userInfo = {
        user,
        active_coupons: totalActiveCoupons,
        balance: userWallet ? ((userWallet.avl_amount - (pendingDebitSum || 0)) > 0 ? userWallet.avl_amount - (pendingDebitSum || 0) : 0) : 0
    };

    return successResp(res, "User profile data.", 200, userInfo);
}
   
async function getUserBalance(req, res, next) {

    // Assuming you have a User model and a way to get the user's balance
    const userId = req.user.id; // Assuming you have user ID in req.user after authentication

    try {
        const user = await UserWallet.findOne({ where: { user_id: userId, deleted_at: null }, attributes: ['avl_amount'] });

        if (!user) {
            return successResp(res, "User balance not found.", 200, { user: userDetails });
        }

        let userDetails = {
            // user_id: userId,
            // user_name: req.user.username,
            // user_email: req.user.email,
            avl_amount: !user ? 0 : user.avl_amount,
        };

        return successResp(res, "User balance retrieved successfully.", 200, { user: userDetails });
    } catch (error) {
        // console.error("Error retrieving user balance:", error);
        return failureResp(res, "An error occurred while retrieving the balance.", 500);
    }
}

async function getPaymentQrCode(req, res, next) {
    const adminWalletId = req.body.id;

    const adminWallet = await AdminWallets.findOne({
        where: Sequelize.where(Sequelize.col('ttl_txn_amount'), '<', Sequelize.col('max_trxn_amount')),
        order: Sequelize.literal('RAND()'),
        attributes: ['id', 'upi_id']
    });

    if (!adminWallet) {
        return successResp(res, "No admin wallet found.", 200, { admin_wallet: [] });
    }

    return successResp(res, "Payment QR Code.", 200, { admin_wallet: adminWallet });
}

async function saveUserAccount(req, res, next) {
    const userId = req.user.id;
    const { account_number, ifsc_code, bank_name } = req.body;
    const userAccount = await userAccountModel.findOne({ where: { user_id: userId, account_number: account_number } });
    if (userAccount) {
        return failureResp(res, "User account already exists.", 200);
    }
    const newUserAccount = await userAccountModel.create({ user_id: userId, account_number, ifsc_code, bank_name });
    if (!newUserAccount) {
        return failureResp(res, "Failed to save user account.", 200);
    }
    return successResp(res, "User account saved successfully.", 200, { userAccount: newUserAccount });
}

async function getUserAccounts(req, res, next) {
    const userId = req.user.id;
    getUserAccounts = await userAccountModel.findAll({ where: { user_id: userId, deleted_at: null } });

    if (!getUserAccounts || getUserAccounts.length === 0) {
        getUserAccounts = [];
    }

    return successResp(res, "User accounts retrieved successfully.", 200, { userAccounts: getUserAccounts });
}

async function withdrawUserBalance(req, res, next) {
    const userId = req.user.id;
    const { amount, account_number_id } = req.body;

    if (req.user.role !== 'client') {
        return failureResp(res, "Unauthorized access.", 403);
    }

    if (!amount || !account_number_id) {
        return failureResp(res, "Amount and account number ID are required.", 400);
    }

    const userWallet = await UserWallet.findOne({ where: { user_id: userId, deleted_at: null } });
    if (!userWallet) {
        return failureResp(res, "User wallet not found.", 404);
    }

    if (userWallet.avl_amount < amount) {
        return failureResp(res, "Insufficient balance.", 422);
    }

    const userAccount = await userAccountModel.findOne({ where: { id: account_number_id, user_id: userId, deleted_at: null } });
    if (!userAccount) {
        return failureResp(res, "Account not found.", 404);
    }

    // Deduct the amount from the user's wallet
    // userWallet.avl_amount -= amount;
    // await userWallet.save();

    // Create a wallet transaction for the withdrawal
    const walletTransaction = await WalletTransactions.create({
        transaction_amount: amount,
        user_wallet_id: userWallet.id,
        type: "debit",
        status: "pending",
        transaction_purpose: "wallet_debit",
        description: `Withdrawal to account ID: ${account_number_id}`,
        client_user_id: account_number_id,
        created_by_user: userId,
    });

    if (!walletTransaction) {
        return failureResp(res, "Failed to create wallet transaction.", 500);
    }

    return successResp(res, "Withdrawal request created successful.", 200, {
        transaction_id: walletTransaction.id,
        amount: amount,
        account_number_id: account_number_id,
        type: "debit",
        transaction_purpose: "wallet_debit",
        status: "pending",
    });
}

async function approveWithdrawRequest(req, res, next) {
    const adminUser = req.user;
    if (adminUser.role !== 'admin') {
        return failureResp(res, "Unauthorized access.", 403);
    }

    const { transaction_id } = req.body;

    if (!transaction_id) {
        return failureResp(res, "Transaction ID is required.", 400);
    }

    const transaction = await sequelize.transaction();
    try {
        const walletTransaction = await WalletTransactions.findOne({
            where: { id: transaction_id, deleted_at: null },
            transaction
        });

        if (!walletTransaction) {
            await transaction.rollback();
            return failureResp(res, "Transaction not found.", 404);
        }

        if (walletTransaction.status === 'approved') {
            await transaction.rollback();
            return failureResp(res, "Transaction already approved.", 422);
        }

        // Update the transaction status to approved
        walletTransaction.status = 'approved';
        await walletTransaction.save({ transaction });

        // Deduct the amount from the admin wallet and add it to the user's wallet
        const userWallet = await UserWallet.findOne({
            where: { id: walletTransaction.user_wallet_id, deleted_at: null },
            transaction
        });
        if (!userWallet) {
            await transaction.rollback();
            return failureResp(res, "User wallet not found.", 404);
        }

        userWallet.avl_amount -= walletTransaction.transaction_amount;
        await userWallet.save({ transaction });

        await transaction.commit();
        return successResp(res, "Withdrawal request approved successfully.", 200, {
            transaction: {
                id: walletTransaction.id,
                amount: walletTransaction.transaction_amount,
                status: walletTransaction.status,
                transaction_purpose: walletTransaction.transaction_purpose,
                created_at: walletTransaction.created_at,
                updated_at: walletTransaction.updated_at,
            }
        });
    } catch (error) {
        await transaction.rollback();
        return failureResp(res, "An error occurred while approving the withdrawal request.", 500);
    }
}

async function getUserPurchasedCoupons(req, res, next) {
    const userId = req.user.id;
    const { page = 1, limit = 10 } = req.query; // Default to page 1 and limit 10 if not provided
    const offset = (page - 1) * limit;

    const transaction = await sequelize.transaction();
    try {
        const baseQuery = `
            FROM coupons c
            JOIN user_coupons uc ON c.id = uc.coupon_id
            WHERE uc.user_id = :userId AND uc.deleted_at IS NULL AND c.deleted_at IS NULL
        `;

        const [coupons, total] = await Promise.all([
            sequelize.query(`
            SELECT c.id, 
            c.coupon_name, 
            c.price, 
            c.max_prize_amount as daily_reward,
            uc.id as user_coupon_id, 
            c.spin_days,
            c.spin_days * c.max_prize_amount as total_prize_amount,
            NOT EXISTS (
                SELECT 1 
                FROM spins s 
                WHERE s.user_coupon_id = uc.id 
                  AND DATE(s.created_at) = CURDATE()
            ) AS rotation_flag,
            uc.created_at AS purchase_date,
            IF(DATE_ADD(uc.created_at, INTERVAL c.spin_days DAY) < NOW(), 'expired', 'active') as coupon_status
            ${baseQuery}
            ORDER BY uc.created_at DESC
            LIMIT :limit OFFSET :offset
            `, {
            replacements: { userId, limit: parseInt(limit), offset: parseInt(offset) },
            type: Sequelize.QueryTypes.SELECT,
            transaction
            }),
            sequelize.query(`
            SELECT COUNT(*) as total
            ${baseQuery}
            `, {
            replacements: { userId },
            type: Sequelize.QueryTypes.SELECT,
            transaction
            })
        ]);

        const totalCount = total[0]?.total || 0;

        if (!coupons || coupons.length === 0) {
            await transaction.rollback();
            return successResp(res, "No purchase coupons found.", 200, { coupons: [], pagination: { page: parseInt(page), limit: parseInt(limit), total: totalCount, totalPages: Math.ceil(totalCount / limit) } });
        }

        await transaction.commit();
        return successResp(res, "Purchased coupons retrieved successfully.", 200, {
            coupons,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                // total: totalCount, 
                totalPages: Math.ceil(totalCount / limit)
            }
        });
    } catch (error) {
        await transaction.rollback();
        return failureResp(res, "Something went wrong please try again later.", 500);
    }
}

async function getUserSpinDetails(req, res, next) {
    try {
        const user_id = req.user.id;
        const { usercouponId } = req.params;

        const spinDetails = await sequelize.query(`
        select uc.id as user_coupon_id, 
        uc.coupon_id as coupon_id,
        c.coupon_name as coupon_name,
        c.price as coupon_price,
        uc.user_id as user_id,
        uc.created_at as coupon_purchase_date,
        s.prize_amount as winning_amount, 
        s.created_at as spin_date,
        DATE_ADD(uc.created_at, INTERVAL c.spin_days DAY) as coupon_expiry_date
        from user_coupons 
        uc join spins s on uc.id=s.user_coupon_id
        join coupons c on c.id=uc.coupon_id
        where uc.user_id=:user_id and uc.id=:usercouponId 
        and uc.deleted_at is null and c.deleted_at is null
        `,
            {
                replacements: { user_id, usercouponId },
                type: Sequelize.QueryTypes.SELECT,
            })

        if (!spinDetails || spinDetails.length === 0) {
            return successResp(res, "No spin details found.", 200, { spinDetails: [], couponDetails: {} });
        }
        let couponDetails = {
            coupon_id: spinDetails[0].coupon_id,
            coupon_purchase_date: spinDetails[0].coupon_purchase_date,
            coupon_expiry_date: spinDetails[0].coupon_expiry_date,
            coupon_name: spinDetails[0].coupon_name,
            coupon_price: spinDetails[0].coupon_price,
        }
        spinDetails.forEach(spin => {
            delete spin.coupon_id;
            delete spin.coupon_purchase_date;
            delete spin.coupon_expiry_date;
            delete spin.coupon_name;
            delete spin.coupon_price;
        });

        return successResp(res, "Success", 200, { spinDetails, couponDetails });



    }
    catch (err) {
        console.error("Login error:", err);
        next(err);
        return failureResp(res, "Something went wrong.", 500, {
            message: err.message,
        });
    }
}

async function addWalletTopup(req, res) {
    // Apply authorization check for admin

    const adminUser = req.user;
    const customerUserId = req.body.user_id;
    // const walletTransactionId = req.body.wallet_transaction_id;
    // const adminWalletId = req.body.admin_wallets_id;

    const {
        transaction_amount,
        admin_wallets_id,
        utr_no,
        admin_wallet_id: adminWalletId
    } = req.body;

    if (adminUser.role !== 'admin') {
        return failureResp(res, "Unauthorized access.", 403);
    }

    try {
        // Find the user's wallet and include wallet transactions
        const userWallet = await UserWallet.findOne({
            where: { user_id: customerUserId, deleted_at: null },
            // include: [
            //     {
            //         model: WalletTransactions,
            //         as: 'transactions',
            //         where: { id: walletTransactionId },
            //         attributes: ['id', 'amount', 'type', 'status', 'created_at']
            //     }
            // ]
        });

        if (!userWallet || !userWallet.length === 0) {
            return failureResp(res, "User Wallet Not Found.", 403);
        }

        if (Number(transaction_amount) <= 0) {
            return failureResp(res, "Transaction amount should be greater than 0.", 403);
        }

        let walletTransaction = await WalletTransactions.create({
            transaction_amount: transaction_amount,
            user_wallet_id: userWallet.id,
            admin_wallets_id: adminWalletId,
            utr_no,
            type: "credit",
            status: "approved",
            transaction_purpose: "wallet_topup",
            description: "wallet topup",
            created_by_admin: adminUser.id,
        });

        if (!walletTransaction) {
            return failureResp(res, "Failed to create wallet transaction.", 500);
        }

        // const adminWalletUpdate = await AdminWallets.increment(
        //     { ttl_txn_amount: transaction_amount },
        //     { where: { id: adminWalletId } }
        // );

        // if (!adminWalletUpdate || adminWalletUpdate[0][1] === 0) {
        //     return failureResp(res, "Failed to update admin wallet.", 500);
        // }

        const userWalletUpdate = await UserWallet.increment(
            { avl_amount: transaction_amount },
            { where: { id: userWallet.id } }
        );

        if (!userWalletUpdate || userWalletUpdate[0][1] === 0) {
            return failureResp(res, "Failed to update user wallet.", 500);
        }

        return successResp(res, "Transaction created successfully.", 201);
    } catch (error) {
        console.log(error);
        return failureResp(res, "An error occurred while creating the transaction.", 500);
    }
}

async function getUserTransactions(req, res, next) {
    // const customerUserId = req.params.userId;
    let { page = 1, limit = 10, purpose = 'wallet_topup' , status } = req.query; // Default to page 1 and limit 10 if not provided
    const offset = (page - 1) * limit;
    if (typeof purpose === 'string') {
        purpose = purpose.split(',').map(p => p.trim());
    }
    const user = req.user;
    let baseQuery = ``;
    let selectAttributes = ``;
    let replacements = {};
    
    if (user.role == 'admin') {
        selectAttributes = `
                wt.id AS wallet_transaction_id,
                wt.transaction_amount,
                wt.type,
                wt.status,
                wt.transaction_purpose,
                wt.created_at`;
        // baseQuery = `FROM admin_wallets aw
        // INNER JOIN wallet_transactions wt ON aw.id = wt.admin_wallets_id
        // WHERE wt.created_by_admin = :userId 
        // AND wt.transaction_purpose in (:purpose)
        // AND aw.deleted_at is null AND wt.deleted_at IS NULL`;
        baseQuery = `FROM wallet_transactions wt
        WHERE wt.transaction_purpose in (:purpose)
        AND wt.deleted_at IS NULL`;
        
        replacements = { purpose };

        if(status) {
            baseQuery += ` AND wt.status = :status`;
            replacements.status = status;
        }

        
    } else {
        selectAttributes = `uw.id AS wallet_id,
        uw.avl_amount,
        wt.id AS wallet_transaction_id,
        wt.transaction_amount,
        wt.type,
        wt.status,
        wt.transaction_purpose,
        wt.created_at`;

        baseQuery = `FROM user_wallet uw
        INNER JOIN wallet_transactions wt ON uw.id = wt.user_wallet_id
        WHERE uw.user_id = :userId 
        AND wt.transaction_purpose in (:purpose)
        AND uw.deleted_at IS NULL AND wt.deleted_at IS NULL`;

        replacements = { userId: user.id, purpose: purpose }

        if(status) {
            baseQuery += ` AND wt.status = :status`;
            replacements.status = status;
        }
    }

    try {

        // Query to get the total count of transactions
        const totalCountResult = await sequelize.query(`
            SELECT COUNT(*) AS total
            ${baseQuery}
        `, {
            replacements: replacements,
            type: Sequelize.QueryTypes.SELECT
        });

        const totalCount = totalCountResult[0]?.total || 0;

        if (totalCount === 0) {
            return successResp(res, "No transactions found.", 200, {
                wallet: {
                    id: null,
                    avl_amount: 0,
                    transactions: []
                },
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: totalCount,
                    totalPages: Math.ceil(totalCount / limit)
                }
            });
        }

        // Query to get the paginated transactions
        const transactionsData = await sequelize.query(`
            SELECT 
                ${selectAttributes}
            ${baseQuery}
            ORDER BY wt.created_at DESC
            LIMIT :limit OFFSET :offset
        `, {
            replacements: { ...replacements, limit: parseInt(limit), offset: parseInt(offset)},
            type: Sequelize.QueryTypes.SELECT
        });

        const wallet = {
            id: transactionsData[0]?.wallet_id || null,
            avl_amount: transactionsData[0]?.avl_amount || 0,
            transactions: transactionsData.map(txn => ({
                id: txn.wallet_transaction_id,
                amount: txn.transaction_amount,
                type: txn.type,
                status: txn.status,
                transaction_purpose: txn.transaction_purpose,
                created_at: txn.created_at
            })).filter(txn => txn.id) // Filter out null transactions
        };

        return successResp(res, "User transactions retrieved successfully.", 200, {
            wallet,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalCount,
                totalPages: Math.ceil(totalCount / limit)
            }
        });
    } catch (error) {
        console.log(error);
        return failureResp(res, "An error occurred while retrieving transactions.", 500);
    }
}

async function getAllUser(req, res) {
    const adminUser = req.user;

    if (adminUser.role !== 'admin') {
        return failureResp(res, "Unauthorized access.", 403);
    }

    let username = req.query.username;

    const queryObj = {
        where: { role: { [Sequelize.Op.ne]: 'admin' } },
        attributes: ['id', 'username', 'first_name', 'last_name', 'email']
    };

    if (username) {
        queryObj.where.username = { [Sequelize.Op.like]: `%${username}%` };
    }

    try {
        const users = await UserModel.findAll(queryObj);

        if (!users || users.length === 0) {
            users = [];
        }

        return successResp(res, "Non-admin users retrieved successfully.", 200, { users });
    } catch (error) {
        return failureResp(res, "An error occurred while retrieving users.", 500);
    }

}

async function addOrUpdateAdminWallet(req, res) {
    const adminUser = req.user;
    if (adminUser.role !== 'admin') {
        return failureResp(res, "Unauthorized access.", 403);
    }

    const { upi_id, max_trxn_amount, account_number } = req.body;

    try {
        const existingAdminWallet = await AdminWallets.findOne({
            where: {
                [Sequelize.Op.or]: [
                    { account_number },
                    { upi_id }
                ],
                deleted_at: null
            }
        });


        if (existingAdminWallet) {
            await existingAdminWallet.update({ upi_id, max_trxn_amount, account_number });
            const { qr_image, ...walletWithoutQrImage } = existingAdminWallet.toJSON();
            return successResp(res, "Admin wallet updated successfully.", 200, { admin_wallet: walletWithoutQrImage });
        } else {
            const newAdminWallet = await AdminWallets.create({ upi_id, max_trxn_amount, account_number });
            const { qr_image, ...walletWithoutQrImage } = newAdminWallet.toJSON();
            return successResp(res, "Admin wallet created successfully.", 201, { admin_wallet: walletWithoutQrImage });
        }
    } catch (error) {
        return failureResp(res, "An error occurred while processing the admin wallet.", 500);
    }
}

async function deleteAdminWallet(req, res) {
    const adminUser = req.user;
    if (adminUser.role !== 'admin') {
        return failureResp(res, "Unauthorized access.", 403);
    }

    const { admin_wallet_id } = req.body;

    try {
        const deletedWallet = await AdminWallets.destroy({ where: { id: admin_wallet_id } });
        if (!deletedWallet) {
            return failureResp(res, "Admin wallet not found.", 404);
        }
        return successResp(res, "Admin wallet deleted successfully.", 200);
    } catch (error) {
        return failureResp(res, "An error occurred while deleting the admin wallet.", 500);
    }
}

async function getAdminWallets(req, res) {
    const adminUser = req.user;
    if (adminUser.role !== 'admin') {
        return failureResp(res, "Unauthorized access.", 403);
    }

    try {
        const adminWallets = await AdminWallets.findAll({ where: { deleted_at: null }, attributes: ['id', 'upi_id', 'account_number', 'max_trxn_amount', 'created_at', 'updated_at'] });
        if (!adminWallets || adminWallets.length === 0) {
            adminWallets = [];
        }
        return successResp(res, "Admin wallets retrieved successfully.", 200, { admin_wallets: adminWallets });
    } catch (error) {
        return failureResp(res, "An error occurred while retrieving admin wallets.", 500);
    }
}

async function userChangePassword(req, res) {
    const userId = req.user.id;
    const { old_password, new_password } = req.body;

    if (!old_password || !new_password) {
        return failureResp(res, "Old password and new password are required.", 404);
    }

    if (old_password === new_password) {
        return failureResp(res, "New password should be different from old password.", 404);
    }

    try {
        const user = await UserModel.findOne({ where: { id: userId, deleted_at: null } });
        if (!user) {
            return failureResp(res, "User not found.", 404);
        }

        const isPasswordValid = await bcrypt.compare(old_password, user.password);
        if (!isPasswordValid) {
            return failureResp(res, "Old password is incorrect.", 401);
        }

        const passHash = await bcrypt.hash(new_password, saltRounds);
        user.password = passHash;
        await user.save();

        return successResp(res, "Password changed successfully.", 200);
    } catch (error) {
        return failureResp(res, "An error occurred while changing the password.", 500);
    }
}

module.exports = {
    getUserProfile,
    getUserBalance,
    getPaymentQrCode,
    saveUserAccount,
    getUserAccounts,
    withdrawUserBalance,
    approveWithdrawRequest,
    getUserPurchasedCoupons,
    getUserSpinDetails,
    addWalletTopup,
    getUserTransactions,
    getAllUser,
    addOrUpdateAdminWallet,
    deleteAdminWallet,
    getAdminWallets,
    userChangePassword
}