const express = require('express');
const jwt = require('jsonwebtoken');
const { notifyError } = require('../../../notify/notifications');

const { userDB } = require('../../../database/database.js');

const router = express.Router();

const JWT_PRIVATE_KEY = `
-----BEGIN PRIVATE KEY-----
${process.env.JWT_PRIVATE_KEY}
-----END PRIVATE KEY-----
`.trim();

router.post('/', async (req, res) => {
  const access_token = req.cookies.access_token;

  if (!access_token) {
    return res.status(400).json({ success: false, error: 'Access Token not found' });
  }

  try {
    const decoded = jwt.verify(access_token, JWT_PRIVATE_KEY);
    const userId = decoded.userId;
    const sid = decoded.sid;

    const userData = await userDB.findOne({ userId: userId, sid: sid });
    if (!userData) {
      res.clearCookie('access_token');
      return res.redirect('/login');
    }

    await userDB.updateOne({ userId }, { $unset: { sid: 1, oauthSid: 1 } });

    res.status(200).json({ success: true });
  } catch (error) {
    notifyError(error);
    return res.status(401).json({ error: 'Invalid access token' });
  }
});

module.exports = router;