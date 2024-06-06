const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = process.env;
const { notifyError } = require('../../../../notify/notifications.js');

const { userDB } = require('../../../../database/database.js');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { password } = req.body;
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

    const passwordPattern = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[@$!%*?&.()/^])([A-Za-z\d@$!%*?&.]{8,})$/;

    if (typeof password !== 'string' || password.length < 8 || password.length > 10000 || !passwordPattern.test(password)) {
      return res.status(465).json({ success: false, error: 'Password must be between 8 and 10000 characters and contain at least one uppercase letter, one lowercase letter, one digit, and one special character' });
    }

    const decoded = jwt.verify(access_token, JWT_SECRET);
    const userId = decoded.userId;
    const sid = decoded.sid;

    const userData = await userDB.findOne({ userId: userId, sid: sid });
    if (!userData) {
      res.clearCookie('access_token');
      return res.redirect('/login');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newsid = [...Array(15)].map(() => Math.random().toString(36)[2]).join('');
    const newOauthSid = [...Array(15)].map(() => Math.random().toString(36)[2]).join('');

    await userDB.updateOne({ userId }, { $set: { password: hashedPassword, sid: newsid, oauthSid: newOauthSid } });

    const newAccessToken = jwt.sign({ userId: userId, sid: newsid }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });

    res.cookie('access_token', newAccessToken, { maxAge: 48 * 60 * 60 * 1000, httpOnly: true, path: '/' });
    res.status(200).json({ success: true });
  } catch (error) {
    notifyError(error);
    return res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});

module.exports = router;