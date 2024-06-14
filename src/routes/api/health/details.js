const express = require('express');
const { userDB, oAuthClientAppDB, oAuthRolesDB } = require('../../../database/database.js');
const { notifyError } = require('../../../notify/notifications.js');
const jwt = require('jsonwebtoken');

const router = express.Router();

const JWT_PUBLIC_KEY = `
-----BEGIN PUBLIC KEY-----
${process.env.JWT_PUBLIC_KEY}
-----END PUBLIC KEY-----
`.trim();

router.get('/', async (req, res) => {
  try {
    const access_token = req.cookies.access_token;

    if (!access_token) {
      return res.status(400).json({ success: false, error: 'Access Token not found' });
    }

    let userInfo;
    jwt.verify(access_token, JWT_PUBLIC_KEY, async (error, decoded) => {
      if (error) {
        return res.redirect('/login');
      }

      const userId = decoded.userId;
      const sid = decoded.sid;

      try {
        userInfo = await userDB.findOne({ userId, sid });

        if (!userInfo) {
          return res.status(401).json({ error: 'Invalid access token' });
        }

        if (userInfo.username !== 'admin') {
          return res.status(401).json({ error: 'User has no access to this resource' });
        }

        const userCount = await userDB.countDocuments();
        const oauthAppsCount = await oAuthClientAppDB.countDocuments();
        const oauthRolesCount = await oAuthRolesDB.countDocuments();

        const error = "Database connection error, or not initialized.";
        if (!userCount) {
          notifyError(error);
          return res.status(500).json({ error: error });
        }

        const response = await fetch('https://google.com', { method: 'GET' });
        if (!response.ok) {
          notifyError('Application has no connection to the internet');
          return res.status(500).json({ error: 'Application has no connection to the internet' });
        }

        const body = {
          status: 'ok',
          details: {
            "Number of users": `${userCount}`,
            "Number of oauth Apps": `${oauthAppsCount}`,
            "Number of oauth Roles": `${oauthRolesCount}`,
          }
        };

        res.status(200).json({ body });
      } catch (error) {
        notifyError(error);
        res.status(500).json({ error: 'Application has encountered an error:', details: error.toString() });
      }
    });
  } catch (error) {
    notifyError(error);
    res.status(500).json({ error: 'Application has encountered an error:', details: error.toString() });
  }
});

module.exports = router;
