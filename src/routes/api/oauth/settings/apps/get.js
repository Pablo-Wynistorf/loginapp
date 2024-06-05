const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = process.env;

const { userDB, oAuthClientAppDB } = require('../../../../../database/database.js');

const router = express.Router();

router.get('/', async (req, res) => {
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

    const userData = await userDB.findOne({ userId, sid });
    if (!userData) {
      res.clearCookie('access_token');
      return res.redirect('/login');
    }

    const userAccess = await userDB.findOne({ userId: userId, sid: sid, providerRoles: 'oauthUser' });

    if (!userAccess) {
      return res.status(465).json({ error: 'User does not have access to create oauth apps' });
    }

    let oauthApps = userData.oauthClientAppIds || [];

    if (!Array.isArray(oauthApps)) {
      return res.status(400).json({ error: 'Invalid format for oauthApps' });
    }

    if (oauthApps.length === 0) {
      return res.status(404).json({ error: 'No OAuth apps found for this user' });
    }

    const oauthAppsData = await oAuthClientAppDB.find({ oauthClientAppId: { $in: oauthApps } }).exec();

    if (!oauthAppsData || oauthAppsData.length === 0) {
      return res.status(404).json({ error: 'No OAuth apps found' });
    }

    const organizedData = oauthAppsData.map(app => ({
      oauthAppName: app.oauthAppName,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      redirectUri: app.redirectUri,
      oauthClientAppId: app.oauthClientAppId,
      accessTokenValidity: app.accessTokenValidity,
    }));

    res.json({ oauthApps: organizedData });
  } catch (error) {
    res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});

module.exports = router;