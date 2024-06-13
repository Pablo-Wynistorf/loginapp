const express = require('express');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const { notifyError } = require('../../../..//notify/notifications');

const { userDB } = require('../../../../database/database.js');

const router = express.Router();

const JWT_PRIVATE_KEY = `
-----BEGIN PRIVATE KEY-----
${process.env.JWT_PRIVATE_KEY}
-----END PRIVATE KEY-----
`.trim();

router.get('/', async (req, res) => {
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
    const mfaEnabled = userData.mfaEnabled;
    const email = userData.email;

    if (mfaEnabled === true) {
      const imageUrl = './img/qr-placeholder.jpg';
      return res.status(460).json({ success: false, imageUrl, error: 'User has MFA already enabled' });
    }

    const mfaSecret = speakeasy.generateSecret({ length: 20 });

    await userDB.updateOne({ userId }, { $set: { mfaSecret: mfaSecret.ascii } });

    const qrCodeUrl = speakeasy.otpauthURL({
      secret: mfaSecret.ascii,
      label: email,
      issuer: URL,
      encoding: 'base64'
    });

    qrcode.toDataURL(qrCodeUrl, (err, imageUrl) => {
      if (err) {
        res.status(500).json({ error: 'Something went wrong, try again later' });
      } else {
        res.status(200).json({ success: true, imageUrl, secret: mfaSecret.ascii });
      }
    });
  } catch (error) {
    notifyError(error);
    return res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});

module.exports = router;