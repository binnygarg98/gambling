var express = require('express');
var router = express.Router();

const userModel = require('../models/user');
const userController = require('../controllers/userController');
const { routes } = require('../app');

/* GET users listing. */

router.get('/' , userController.getAllUser);
router.get('/balance', userController.getUserBalance);
router.get('/profile', userController.getUserProfile);
router.get('/paymentQRCode', userController.getPaymentQrCode);
router.post('/account', userController.saveUserAccount);
router.get('/account', userController.getUserAccounts);
router.post('/account/withdraw', userController.withdrawUserBalance);
router.post('/account/withdraw/approve', userController.approveWithdrawRequest);

router.get('/purchased-coupons', userController.getUserPurchasedCoupons);
router.get('/coupons-spin-details/:usercouponId', userController.getUserSpinDetails);

router.post('/add-wallet-topup', userController.addWalletTopup);
router.get('/transactions', userController.getUserTransactions);

router.get('/admin-wallet', userController.getAdminWallets);
router.put('/admin-wallet', userController.addOrUpdateAdminWallet);
router.delete('/admin-wallet', userController.deleteAdminWallet);
router.post('/change-password' , userController.userChangePassword);


module.exports = router;
 