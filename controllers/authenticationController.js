const UserModel = require('../models/user');
const { failureResp, successResp } = require('../utils/response');
const bcrypt = require('bcrypt');
const UserService = require('../service/UserService');
const saltRounds = parseInt(process.env.SALT_ROUNDS || '10', 10);
const AuthError = require('../exceptions/AppException');
const UserWallet = require('../models/userWallet');

async function signup(req, res, next) {
    const { username, password, first_name, last_name, email, role } = req.body;

    if (!username || !password) {
        return res.status(400).send('Username and password are required.');
    }

    //TODO : check for email as well
    let user = await UserModel.findOne({ where: { username: username } });

    if (user) {
        return failureResp(res, "User already exists.");
    }


    const passHash = await bcrypt.hash(password, saltRounds);

    user = await UserModel.create({ username, password: passHash, first_name, last_name, email, role });
    // Save wallet information for the user
    const userWallet = await UserWallet.create({ avl_amount: 0 , user_id: user.id});

    if(!userWallet) {
        //TODO: log error
        return failureResp(res, "Failed to create user wallet.", 500);
    }

    return successResp(res, "User created successfuly.", 200);
}

async function login(req, res, next) {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).send('Username and password are required.');
        }
        const userDetails = await UserService.login(req, res);
        if (!userDetails) {
            return failureResp(res, "User does not exist.", 409);
        }
        return successResp(res, "User logged in successfully.", 200, userDetails);
    }
    catch (err) {
        console.error("Login error:", err);
        next(err);
        return failureResp(res, "Something went wrong during login.", 500, {
            message: err.message,
        });
    }
}

module.exports = { signup, login };