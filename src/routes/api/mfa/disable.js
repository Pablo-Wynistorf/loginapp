const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = process.env;
const { notifyError } = require('../../../notify/notifications');

const { userDB } = require('../../../database/database.js');

const router = express.Router();

router.post('/', async (req, res) => {
  const req_cookies = req.headers.cookie;

  if (!req_cookies) {
    return res.status(400).json({ success: false, error: 'Access Token not found' });
  }

  const cookies = req_cookies.split(';').reduce((cookiesObj, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookiesObj[name] = value;
    return cookiesObj;
  }, {});

  const access_token = cookies['access_token'];

  try {
    const decoded = jwt.verify(access_token, JWT_SECRET);
    const userId = decoded.userId;
    const sid = decoded.sid;

    const userData = await userDB.findOne({ userId: userId, sid: sid });
    if (!userData) {
      res.clearCookie('access_token');
      return res.redirect('/login');
    }
    const mfaEnabled = userData.mfaEnabled;

    if (mfaEnabled === false) {
      return res.status(462).json({ success: false, error: 'MFA is not enabled' });
    }

    await userDB.updateOne({ userId }, { $unset: { mfaSecret: 1, mfaLoginSecret: 1 } });
    await userDB.updateOne({ userId }, { $set: { mfaEnabled: false } });

    return res.status(200).json({ success: true, message: 'MFA has been successfully disabled' });
  } catch (error) {
    notifyError(error);
    return res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});

module.exports = router;