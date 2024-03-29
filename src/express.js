const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const mailjet = require('node-mailjet');
const path = require('path');
const qrcode = require('qrcode');
const speakeasy = require('speakeasy');
require('dotenv').config();

const URL = process.env.URL;
const DATABASE_URI = process.env.DATABASE_URI;
const API_PORT = process.env.API_PORT;
const JWT_SECRET = process.env.JWT_SECRET;
const MJ_APIKEY_PUBLIC = process.env.MJ_APIKEY_PUBLIC;
const MJ_APIKEY_PRIVATE = process.env.MJ_APIKEY_PRIVATE;
const MJ_SENDER_EMAIL = process.env.MJ_SENDER_EMAIL;
const DC_MONITORING_WEBHOOK_URL = process.env.DC_MONITORING_WEBHOOK_URL;

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser()); 
app.use(bodyParser.urlencoded({ extended: true }));

function connectToDatabase() {
  mongoose.connect(DATABASE_URI);
}
const db = mongoose.connection;

connectToDatabase();

db.on('error', () => {
  console.log('MongoDB connection error. Reconnecting...');
  setTimeout(connectToDatabase, 5000);
});

db.on('disconnected', () => {
  console.log('MongoDB disconnected. Reconnecting...');
  setTimeout(connectToDatabase, 5000);
  return;
});

db.on('connected', () => {
  console.log('Connected to MongoDB');
});

const { Schema } = mongoose;

const userSchema = new Schema({
  userId: String,
  username: String,
  password: String,
  email: String,
  sid: String,
  oauthSid: String,
  verifyCode: String,
  resetCode: String,
  mfaSecret: String,
  mfaLoginSecret: String,
  mfaEnabled: Boolean,
  providerRoles: Array,
  oauthClientAppIds: Array,
  oauthAuthorizationCode: String,
}, {
  timestamps: true
});

const oAuthClientSchema = new mongoose.Schema({
  oauthAppName: String,
  oauthClientAppId: String,
  clientId: String,
  clientSecret: String,
  redirectUri: String,
  accessTokenValidity: Number,
  oauthRoleIds: Array,
}, {
  timestamps: true
});

const oAuthRolesSchema = new mongoose.Schema({
  oauthRoleId: String,
  oauthClientAppId: String,
  oauthClientId: String,
  oauthRoleName: String,
  oauthUserIds: Array,
}, {
  timestamps: true
});


const userDB = mongoose.model('users', userSchema);
const oAuthClientAppDB = mongoose.model('oauthClientApps', oAuthClientSchema);
const oAuthRolesDB = mongoose.model('oauthRoles', oAuthRolesSchema);

app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    connectToDatabase();
  }
  next();
});

const authLoginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: 'Too many requests. Please try again later.',
});

const authRegisterLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  message: 'Too many requests. Please try again later.',
});


// Verify access token
const verifyToken = (req, res, next) => {
  const access_token_cookie = req.headers.cookie;
  const requestedPath = req.baseUrl;

  if (access_token_cookie) {
    const cookies = access_token_cookie.split(';').reduce((cookiesObj, cookie) => {
      const [name, value] = cookie.trim().split('=');
      cookiesObj[name] = value;
      return cookiesObj;
    }, {});

    const access_token = cookies['access_token'];

    jwt.verify(access_token, JWT_SECRET, async (error, decoded) => {
      if (error) {
        res.clearCookie('access_token');
        if (requestedPath !== '/login') {
          return res.redirect('/login');
        }
        return next();
      }

      const userId = decoded.userId;
      const sid = decoded.sid;

      try {
        const userData = await userDB.findOne({ userId: userId, sid: sid });
        if (!userData) {
          res.clearCookie('access_token');
          return res.redirect('/login');
        }
        if (requestedPath !== '/home' && requestedPath !== '/home/mfa/settings' && requestedPath !== '/home/oauth/settings' && requestedPath !== '/home/oauth/settings/roles') {
          return res.redirect('/home');
        }

        const now = Math.floor(Date.now() / 1000);
        const tokenExpirationThreshold = now + (24 * 60 * 60);
        if (decoded.exp < tokenExpirationThreshold) {
          const newAccessToken = jwt.sign({ userId: userId, sid: sid }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });
          res.cookie('access_token', newAccessToken, { maxAge: 48 * 60 * 60 * 1000, httpOnly: true, path: '/'});
        }

        res.clearCookie('email_verification_token');
        res.clearCookie('password_reset_token');
        res.clearCookie('password_reset_code');
        next();
      } catch (error) {
        res.clearCookie('access_token');
        return res.redirect('/login');
      }
    });
  } else {
    return res.redirect('/login');
  }
};



// Handle existing access token
const existingToken = (req, res, next) => {
  const access_token_cookie = req.headers.cookie;

  if (access_token_cookie) {
    const cookies = access_token_cookie.split(';').reduce((cookiesObj, cookie) => {
      const [name, value] = cookie.trim().split('=');
      cookiesObj[name] = value;
      return cookiesObj;
    }, {});

    const access_token = cookies['access_token'];

    if (access_token) {
      return verifyToken(req, res, next);
    }
  }
  next();
};



// Redirect to /login
app.get('/', (req, res) => {
  res.redirect('/login');
});



// All express routes
app.use('/login', existingToken, express.static(path.join(__dirname, 'public/login')));
app.use('/home', verifyToken, express.static(path.join(__dirname, 'public/home')));
app.use('/register', existingToken, express.static(path.join(__dirname, 'public/register')));
app.use('/setpassword', express.static(path.join(__dirname, 'public/setpassword')));
app.use('/verify', existingToken, express.static(path.join(__dirname, 'public/verify')));
app.use('/recover', existingToken, express.static(path.join(__dirname, 'public/recover')));
app.use('/home/mfa/settings', existingToken, express.static(path.join(__dirname, 'public/mfasettings')));
app.use('/mfa', express.static(path.join(__dirname, 'public/mfa')));
app.use('/home/oauth/settings', verifyToken, express.static(path.join(__dirname, 'public/oauthsettings')));
app.use('/home/oauth/settings/roles', verifyToken, express.static(path.join(__dirname, 'public/oauthrolesettings')));


// Login to the account, if account not verified, resend verification email.
app.post('/api/sso/token/check', async (req, res) => {
  const { access_token } = req.body;
  jwt.verify(access_token, JWT_SECRET, async (error, decoded) => {
    if (error) {
      res.clearCookie('access_token');
      return res.redirect(`${URL}/login`);
    }

    const userId = decoded.userId;
    const sid = decoded.sid;

    try {
      const userData = await userDB.findOne({ userId: userId, sid: sid });
      if (!userData) {
        res.clearCookie('access_token');
        return res.redirect(`${URL}/login`);
      }
      res.clearCookie('email_verification_token');
      res.clearCookie('password_reset_token');
      res.clearCookie('password_reset_code');
      res.status(200).json({ success: true });
    } catch (error) {
      res.clearCookie('access_token');
      return res.redirect('/login');
    }
  });

});




// Login to the account, if account not verified, resend verification email.
app.post('/api/sso/auth/login', authLoginLimiter, async (req, res) => {
  const { username_or_email, password, redirectUri } = req.body;
  const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/;

  try {
    let user;

    if (emailRegex.test(username_or_email)) {
      user = await userDB.findOne({ email: username_or_email });
    } else {
      user = await userDB.findOne({ username: username_or_email });
    }

    if (!user) {
      return res.status(462).json({ success: false, error: 'Invalid username or password' });
    }

    const storedPasswordHash = user.password;
    const userId = user.userId;
    const email_verification_code = user.verifyCode;
    const username = user.username;
    const email = user.email;
    const mfaEnabled = user.mfaEnabled;
    const sid = user.sid;

    const passwordMatch = await bcrypt.compare(password, storedPasswordHash);

    if (!passwordMatch) {
      return res.status(462).json({ success: false, error: 'Invalid username or password' });
    }

    if (email_verification_code) {
      const email_verification_token = jwt.sign({ userId: userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });

      const new_email_verification_code = Math.floor(100000 + Math.random() * 900000).toString();
      await userDB.updateOne({ userId }, { $set: { verifyCode: new_email_verification_code } });

      res.cookie('email_verification_token', email_verification_token, { maxAge: 5 * 60 * 1000, httpOnly: true, path: '/' });
      res.status(461).json({ success: true, Message: 'Email not verified' });
      sendVerificationEmail(username, email, email_verification_token, new_email_verification_code, res);
    } else {
    
      loginSuccess(userId, username, sid, res, mfaEnabled, redirectUri);
    }
  } catch (error) {
    notifyError(error);
    return res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Handle successful login and generate access tokens
async function loginSuccess(userId, username, sid, res, mfaEnabled, redirectUri) {
  if (!sid) {
    const newsid = [...Array(15)].map(() => Math.random().toString(36)[2]).join('');
    const newoAuthSid = [...Array(15)].map(() => Math.random().toString(36)[2]).join('');
    await userDB.updateOne({ userId }, { $set: { sid: newsid, oauthSid: newoAuthSid } });

    if (mfaEnabled === true) {
      const newMfaLoginSecret = [...Array(30)].map(() => Math.random().toString(36)[2]).join('');
      await userDB.updateOne({ userId }, { $set: { mfaLoginSecret: newMfaLoginSecret } });
      const mfa_token = jwt.sign({ userId: userId, mfaLoginSecret: newMfaLoginSecret }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
      res.cookie('mfa_token', mfa_token, { maxAge: 5 * 60 * 1000, httpOnly: true, path: '/' });
      return res.status(463).json({ success: true, message: 'Redirecting to mfa site', redirectUri });
    }

    notifyLogin(username);
    const token = jwt.sign({ userId: userId, sid: newsid }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });
    res.cookie('access_token', token, { maxAge: 48 * 60 * 60 * 1000, httpOnly: true, path: '/' });
    return res.status(200).json({ success: true, redirectUri  });
  }

  if (mfaEnabled === true) {
    const newMfaLoginSecret = [...Array(30)].map(() => Math.random().toString(36)[2]).join('');
    await userDB.updateOne({ userId }, { $set: { mfaLoginSecret: newMfaLoginSecret } });
    const mfa_token = jwt.sign({ userId: userId, mfaLoginSecret: newMfaLoginSecret }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
    res.cookie('mfa_token', mfa_token, { maxAge: 5 * 60 * 1000, httpOnly: true, path: '/' });
    return res.status(463).json({ success: true, message: 'Redirecting to mfa site', redirectUri })
  }

  const token = jwt.sign({ userId: userId, sid: sid }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });
  notifyLogin(username);
  res.cookie('access_token', token, { maxAge: 48 * 60 * 60 * 1000, httpOnly: true, path: '/' });

  return res.status(200).json({ success: true, redirectUri });
}




// Register as new user, store userdata in the database and send verification email
app.post('/api/sso/auth/register', authRegisterLimiter, async (req, res) => {
  const { username, password, email } = req.body;
  const usernameRegex = /^[a-zA-Z0-9-]{3,20}$/;
  const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/;
  const passwordPattern = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[@$!%*?&.()/^])([A-Za-z\d@$!%*?&.]{8,})$/;

  if (!usernameRegex.test(username)) {
    return res.status(462).json({ success: false, error: 'Username must only contain letters, numbers, and dashes and be between 3 and 20 characters' });
  }

  if (!emailRegex.test(email)) {
    return res.status(466).json({ success: false, error: 'Invalid email address' });
  }

  if (typeof password !== 'string' || password.length < 8 || password.length > 23 || !passwordPattern.test(password)) {
    return res.status(465).json({ success: false, error: 'Password must be between 8 and 23 characters and contain at least one uppercase letter, one lowercase letter, one digit, and one special character' });
  }

  try {
    let existingUsername = await userDB.findOne({ username });
    let existingEmail = await userDB.findOne({ email });

    if (existingEmail) {
      return res.status(460).json({ success: false, error: 'Email already used, try login' });
    }

    if (existingUsername) {
      return res.status(461).json({ success: false, error: 'Username already taken' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    let userId;
    let existingUserId;

    do {
      userId = Math.floor(Math.random() * 900000000000) + 100000000000;
      existingUserId = await userDB.findOne({ userId });
    } while (existingUserId);

    const email_verification_token = jwt.sign({ userId: userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
    const email_verification_code = Math.floor(100000 + Math.random() * 900000).toString();

    const newUser = new userDB({
      userId: userId,
      username: username,
      password: hashedPassword,
      email: email,
      verifyCode: email_verification_code,
      mfaEnabled: false,
      providerRoles: ['standardUser', 'oauthUser'],
    });

    await newUser.save();

    sendVerificationEmail(username, email, email_verification_token, email_verification_code);

    res.cookie('email_verification_token', email_verification_token, { maxAge: 5 * 60 * 1000, httpOnly: true, path: '/' });
    res.status(200).json({ success: true });
    return notifyRegister(username);
  } catch (error) {
    notifyError(error);
    res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Verify user with verification code and token, and later generate access tokens
app.post('/api/sso/verify', async (req, res) => {
  try {
    const { email_verification_code } = req.body;
    const req_cookies = req.headers.cookie;

    if (!req_cookies) {
      return res.status(400).json({ success: false, error: 'Email verification token not found' });
    }

    const cookies = req_cookies.split(';').reduce((cookiesObj, cookie) => {
      const [name, value] = cookie.trim().split('=');
      cookiesObj[name] = value;
      return cookiesObj;
    }, {});

    const email_verification_token = cookies['email_verification_token'];
    

    const decoded = await jwt.verify(email_verification_token, JWT_SECRET);

    const userId = decoded.userId;
    const verifyCode = email_verification_code;

    const existingUserId = await userDB.findOne({ userId, verifyCode });

    if (!existingUserId) {
      return res.status(460).json({ success: false, error: 'Wrong verification code entered' });
    }

    const sid = [...Array(15)].map(() => Math.random().toString(36)[2]).join('');
    const oauthSid = [...Array(15)].map(() => Math.random().toString(36)[2]).join('');

    await userDB.updateOne({ userId }, {
      $set: { sid: sid, oauthSid: oauthSid },
      $unset: { verifyCode: 1 }
    });

    const access_token = jwt.sign({ userId: userId, sid: sid }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });
    res.cookie('access_token', access_token, { maxAge: 48 * 60 * 60 * 1000, httpOnly: true, path: '/' });
    return res.status(200).json({ success: true });
  } catch (error) {
    notifyError(error);
    return res.status(500).json({ success: false, error: 'Something went wrong, try again later' });
  }
});



// Verify user with verification code and token with the verificationlink, and later generate access tokens
app.all('/api/sso/confirmationlink/:email_verification_token/:email_verification_code', async (req, res) => {
  try {
    const { email_verification_token ,email_verification_code } = req.params;

    const decoded = await jwt.verify(email_verification_token, JWT_SECRET);

    const userId = decoded.userId;
    const verifyCode = email_verification_code;

    const existingUserId = await userDB.findOne({ userId, verifyCode });

    if (!existingUserId) {
      return res.status(460).json({ success: false, error: 'Wrong verification code entered' });
    }

    const sid = [...Array(15)].map(() => Math.random().toString(36)[2]).join('');
    const oauthSid = [...Array(15)].map(() => Math.random().toString(36)[2]).join('');

    await userDB.updateOne({ userId }, {
      $set: { sid: sid, oauthSid: oauthSid },
      $unset: { verifyCode: 1 }
    });

    const access_token = jwt.sign({ userId: userId, sid: sid }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });
    res.cookie('access_token', access_token, { maxAge: 48 * 60 * 60 * 1000, httpOnly: true, path: '/' });
    return res.redirect('/home');
  } catch (error) {
    notifyError(error);
    return res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Convert link into usable password_reset_code and password_reset_token cookies
app.all('/api/sso/setresettokens/:password_reset_token/:password_reset_code', (req, res) => {
  const { password_reset_token, password_reset_code } = req.params;
    res.cookie('password_reset_token', password_reset_token, { maxAge: 1 * 60 * 60 * 1000, httpOnly: true, path: '/' });
    res.cookie('password_reset_code', password_reset_code, { maxAge: 1 * 60 * 60 * 1000, path: '/' });
    return res.redirect('/setpassword')
});



// Handle password change, define new session id, store passwordhash in database and issue new access token. 
app.post('/api/sso/data/changepassword', async (req, res) => {
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


    if (!passwordPattern.test(password)) {
      return res.status(462).json({ success: false, error: 'Password doesn\'t meet our requirements' });
    }

    if (typeof password !== 'string' || password.length < 5) {
      return res.status(460).json({ success: false, error: 'Password must have at least 5 characters' });
    }

    if (typeof password !== 'string' || password.length > 23) {
      return res.status(461).json({ success: false, error: 'Password must not have more than 23 characters' });
    }

    const decoded = jwt.verify(access_token, JWT_SECRET)
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

    await userDB.updateOne({ userId }, { $set: { password: hashedPassword, sid: newsid, oauthSid: newOauthSid} });

    const newAccessToken = jwt.sign({ userId: userId, sid: newsid }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });

    res.cookie('access_token', newAccessToken, { maxAge: 48 * 60 * 60 * 1000, httpOnly: true, path: '/' });
    res.status(200).json({ success: true });
  } catch (error) {
    notifyError(error)
    return res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});


// Handle logout
app.post('/api/sso/auth/logout', async (req, res) => {
  res.clearCookie('access_token');
  res.status(200).json({ success: true });
});




// Handle logout and change session id. (Invalidate access token)
app.post('/api/sso/auth/logout/all', async (req, res) => {
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

    await userDB.updateOne({ userId }, { $unset: { sid: 1, oauthSid: 1 } });

    res.status(200).json({ success: true});
  } catch (error) {
    notifyError(error)
    return res.status(401).json({ error: 'Invalid access token' });
  }
});



// Make a password reset request and send recovery code. 
app.post('/api/sso/data/resetpassword', async (req, res) => {
  const { email } = req.body;

  try {
    const userData = await userDB.findOne({ email });
    if (!userData) {
      return res.status(404).json({ success: false, error: 'No account with this email' });
    }

    const userId = userData.userId;
    const username = userData.username;
    const password_reset_token = jwt.sign({ userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const password_reset_code = Math.floor(100000 + Math.random() * 900000).toString();

    await userDB.updateOne({ userId }, { $set: { resetCode: password_reset_code } });

    try {
      sendRecoveryEmail(username, email, password_reset_token, password_reset_code, res);
      res.cookie('password_reset_token', password_reset_token, { maxAge: 1 * 60 * 60 * 1000, httpOnly: true, path: '/' });
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Mailjet error:', error);
      res.status(500).json({ error: 'Failed to send password reset email' });
    }
  } catch (error) {
    notifyError(error)
    res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Set new password with recoverycode and recoverytoken. 
app.post('/api/sso/data/setpassword', async (req, res) => {
  const { password, password_reset_code } = req.body;
  const passwordPattern = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[@$!%*?&.()/^])([A-Za-z\d@$!%*?&.]{8,})$/;
  const req_cookies = req.headers.cookie;

  if (!req_cookies) {
    return res.status(400).json({ success: false, error: 'Access Token not found' });
  }

  const cookies = req_cookies.split(';').reduce((cookiesObj, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookiesObj[name] = value;
    return cookiesObj;
  }, {});

  const password_reset_token = cookies['password_reset_token'];
  
  try {
    if (!passwordPattern.test(password)) {
      return res.status(462).json({ success: false, error: 'Password doesn\'t meet our requirements' });
    }

    if (typeof password !== 'string' || password.length < 8) {
      return res.status(463).json({ success: false, error: 'Password must have at least 8 characters' });
    }

    if (typeof password !== 'string' || password.length > 23) {
      return res.status(464).json({ success: false, error: 'Password must not have more than 23 characters' });
    }

    try {
      const decoded = jwt.verify(password_reset_token, JWT_SECRET);

      const userId = decoded.userId;

      const userReset = await userDB.findOne({ userId: userId, resetCode: password_reset_code });
      if (!userReset) {
        return res.status(460).json({ error: 'Wrong recovery code entered'})
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const newsid = [...Array(15)].map(() => Math.random().toString(36)[2]).join('');

      await userDB.updateOne({ userId }, { $set: { password: hashedPassword, sid: newsid } });
      await userDB.updateOne({ userId }, { $unset: { resetCode: 1 } });


      const access_token = jwt.sign({userId: userId, sid: newsid}, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });
      res.clearCookie('password_reset_token');
      res.cookie('access_token', access_token, { maxAge: 48 * 60 * 60 * 1000, httpOnly: true, path: '/' });
      res.status(200).json({ success: true });

  
    } catch (error) {
      return res.status(401).json({ error: 'Invalid password reset token' });
    }
  } catch (error) {
    notifyError(error)
    res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Get the mfa qr code
app.get('/api/mfa/setup', async (req, res) => {
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
    const email = userData.email;

    if (mfaEnabled === true) {
      const imageUrl = './img/qr-placeholder.jpg'
      return res.status(460).json({ success: false, imageUrl, error: 'User has mfa already enabled'})
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



// Disable MFA
app.post('/api/mfa/disable', async (req, res) => {
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
      return res.status(462).json({ success: false, error: 'MFA is not enabled'})
    }
    
    await userDB.updateOne({ userId }, { $unset: { mfaSecret: 1, mfaLoginSecret: 1 } });
    await userDB.updateOne({ userId }, { $set: { mfaEnabled: false }});

    return res.status(200).json({ success: true, message: 'MFA has been successfully disabled' });
  } catch (error) {
    notifyError(error);
    return res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Mfa setup verify
app.post('/api/mfa/setup/verify', async (req, res) => {
  const mfaVerifyCode = req.body.mfaVerifyCode;

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
    const mfaSecret = userData.mfaSecret;

    if (mfaEnabled === true) {
      return res.status(460).json({ error: 'User has mfa already enabled' });
    }

    const verified = speakeasy.totp.verify({
      secret: mfaSecret,
      encoding: 'base64',
      token: mfaVerifyCode,
      window: 2
  });
  if (verified) {
    await userDB.updateOne({ userId }, { $set: { mfaEnabled: true }});

    const newsid = [...Array(15)].map(() => Math.random().toString(36)[2]).join('');
    await userDB.updateOne({ userId: userId, sid: sid }, { $set: { sid: newsid,  } });

    const token = jwt.sign({ userId: userId, sid: newsid }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });
    res.cookie('access_token', token, { maxAge: 48 * 60 * 60 * 1000, httpOnly: true, path: '/' });
    
    return res.status(200).json({ success: true, message: 'MFA enabled'})
  } else {
    return res.status(461).json({ success: false, error: 'Invalid verification code'})
  }
  } catch (error) {
    notifyError(error);
    return res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Verify the mfa code
app.post('/api/mfa/verify', async (req, res) => {
  const mfaVerifyCode = req.body.mfaVerifyCode;
  const redirectUri = req.body.redirectUri;

  const req_cookies = req.headers.cookie;

  if (!req_cookies) {
    return res.status(462).json({ success: false, error: 'Access Token not found' });
  }

  const cookies = req_cookies.split(';').reduce((cookiesObj, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookiesObj[name] = value;
    return cookiesObj;
  }, {});

  const mfa_token = cookies['mfa_token'];

  try {
    const decoded = jwt.verify(mfa_token, JWT_SECRET);
    const userId = decoded.userId;
    const mfaLoginSecret = decoded.mfaLoginSecret;
    const userData = await userDB.findOne({ userId: userId, mfaLoginSecret: mfaLoginSecret });

    if (!userData) {
      res.clearCookie('mfa_token');
      return res.redirect('/login');
    }

    const mfaEnabled = userData.mfaEnabled;
    const mfaSecret = userData.mfaSecret;
    const sid = userData.sid;
    const username = userData.username;


    if (mfaEnabled !== true) {
      return res.status(460).json({ error: 'User has mfa not enabled' });
    }

    const verified = speakeasy.totp.verify({
      secret: mfaSecret,
      encoding: 'base64',
      token: mfaVerifyCode,
      window: 2
  });
  if (verified) {
    const token = jwt.sign({ userId: userId, sid: sid }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });
    notifyLogin(username);
    res.cookie('access_token', token, { maxAge: 48 * 60 * 60 * 1000, httpOnly: true, path: '/' });
    res.clearCookie('mfa_token');
    return res.status(200).json({ success: true, redirectUri });
  } else {
    return res.status(461).json({ success: false, error: 'Invalid verification code'})
  }
  } catch (error) {
    notifyError(error);
    return res.status(460).json({ error: 'User has mfa not enabled' });
  }
});



// Get oauth apps
app.get('/api/oauth/settings/get', async (req, res) => {
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

    const userAccess = await userDB.findOne({ userId: userId, sid: sid, providerRoles: 'oauthUser'});

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



// Add oauth app
app.post('/api/oauth/settings/add', async (req, res) => {
  const oauthAppName = req.body.oauthAppName;
  const redirectUri = req.body.redirectUri;
  const accessTokenValidity = req.body.accessTokenValidity;
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

  const oauthAppNameRegex = /^[a-zA-Z0-9\-\.]{1,30}$/;

  if (!oauthAppNameRegex.test(oauthAppName)) {
    return res.status(460).json({ success: false, error: 'Invalid oauthAppName' }); 
  }

  const oauthRedirectUrlRegex = /^[a-zA-Z0-9\.:\/_!?-]+$/;

  if (!oauthRedirectUrlRegex.test(redirectUri)) {
    return res.status(460).json({ success: false, error: 'Invalid oauthRedirectUrl' }); 
}

if (isNaN(accessTokenValidity) || accessTokenValidity < 0 || accessTokenValidity > 604800) {
  return res.status(460).json({ success: false, error: 'Invalid access token validity' });
}



  try {
    const decoded = jwt.verify(access_token, JWT_SECRET);
    const userId = decoded.userId;
    const sid = decoded.sid;
    
    const userData = await userDB.findOne({ userId: userId, sid: sid });
    if (!userData) {
      res.clearCookie('access_token');
      return res.redirect('/login');
    }

    const userAccess = await userDB.findOne({ userId: userId, sid: sid, providerRoles: 'oauthUser'});

    if (!userAccess) {
      return res.status(465).json({ error: 'User does not have access to create oauth apps' });
    }

    let oauthClientAppId;
    let existingoauthClientAppId;
    do {
      oauthClientAppId = Math.floor(Math.random() * 900000) + 100000;
      existingoauthClientAppId = await oAuthClientAppDB.findOne({ oauthClientAppId });
    } while (existingoauthClientAppId);

    let clientId;
    let existingClientId;
    do {
      clientId = [...Array(45)].map(() => Math.random().toString(36)[2]).join('');
      existingClientId = await oAuthClientAppDB.findOne({ clientId });
    } while (existingClientId);

    let clientSecret;
    let existingclientSecret;
    do {
      clientSecret = [...Array(45)].map(() => Math.random().toString(36)[2]).join('');
      existingclientSecret = await oAuthClientAppDB.findOne({ clientSecret });
    } while (existingclientSecret);


    const newoauthClientApp = new oAuthClientAppDB({
      oauthAppName: oauthAppName,
      oauthClientAppId: oauthClientAppId,
      clientId: clientId,
      clientSecret: clientSecret,
      redirectUri: redirectUri,
      accessTokenValidity: accessTokenValidity,
    });

    
    await newoauthClientApp.save();
    await userDB.updateOne({ userId }, { $push: { oauthClientAppIds: oauthClientAppId } });

    res.status(200).json({ success: true, clientId, clientSecret, redirectUri, oauthClientAppId, oauthAppName, accessTokenValidity});
  } catch (error) {
    res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Add oauth delete app
app.post('/api/oauth/settings/delete', async (req, res) => {
  const oauthClientAppId = req.body.oauthClientAppId;
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

    const userAccess = await userDB.findOne({ userId: userId, sid: sid, providerRoles: 'oauthUser'});

    if (!userAccess) {
      return res.status(465).json({ error: 'User does not have access to create oauth apps' });
    }

    const testOauthClientAppId = userData.oauthClientAppIds.includes(oauthClientAppId);
    
    if (testOauthClientAppId === false) {
    return res.status(460).json({ error: 'User does not own this oauth app' });
    }

    await oAuthClientAppDB.deleteOne({ oauthClientAppId });
    await oAuthRolesDB.deleteMany({ oauthRoleId: { $regex: `${oauthClientAppId}-*` } });
    await userDB.updateOne(
      { userId },
      { $pull: { oauthClientAppIds: parseInt(oauthClientAppId) } }
    );
    
    res.status(200).json({ success: true, message: 'OAuth app has been successfully deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Get oauth app roles
app.post('/api/oauth/settings/roles/get', async (req, res) => {
  const req_cookies = req.headers.cookie;
  const oauthClientAppId = req.body.oauthClientAppId;

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

    const userAccess = await userDB.findOne({ userId: userId, sid: sid, providerRoles: 'oauthUser'});

    if (!userAccess) {
      return res.status(465).json({ error: 'User does not have access to manage oauth apps' });
    }

    let oauthApps = userData.oauthClientAppIds || [];

    if (!Array.isArray(oauthApps)) {
      return res.status(400).json({ error: 'Invalid format for oauthApps' });
    }

    if (oauthApps.length === 0) {
      return res.status(404).json({ error: 'No oAuth apps found for this user' });
    }

    if (oauthApps.indexOf(oauthClientAppId) === -1) {
      return res.status(466).json({ error: 'User does not have access to this oauth app' });
    }

    const oauthRolesData = await oAuthRolesDB.find({ oauthRoleId: { $regex: `${oauthClientAppId}-*` } });


    if (!oauthRolesData || oauthRolesData.length === 0) {
      return res.status(404).json({ error: 'No OAuth roles found for this app' });
    }

    const organizedData = oauthRolesData.map(app => ({
      oauthRoleId: app.oauthRoleId,
      oauthRoleName: app.oauthRoleName,
      oauthUserIds: app.oauthUserIds,
    }));

    res.json({ oauthRoles: organizedData });
  } catch (error) {
    res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Add oauth app role
app.post('/api/oauth/settings/roles/add', async (req, res) => {
  const req_cookies = req.headers.cookie;
  const oauthClientAppId = req.body.oauthClientAppId;
  const oauthRoleName = req.body.oauthRoleName;

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

    const userAccess = await userDB.findOne({ userId: userId, sid: sid, providerRoles: 'oauthUser'});

    if (!userAccess) {
      return res.status(460).json({ error: 'User has no permissions to manage oauth apps' });
    }

    let oauthApps = userData.oauthClientAppIds || [];

    if (!Array.isArray(oauthApps)) {
      return res.status(400).json({ error: 'Invalid format for oauthApps' });
    }

    if (oauthApps.length === 0) {
      return res.status(404).json({ error: 'No oAuth apps found for this user' });
    }

    if (oauthApps.indexOf(oauthClientAppId) === -1) {
      return res.status(461).json({ error: 'User does not have access to this oauth app' });
    }

    const validRoleName = /^[a-zA-Z0-9\-_\.]{1,40}$/;

    if (!validRoleName.test(oauthRoleName)) {
      return res.status(462).json({ error: 'Invalid role name' });
    }

    const oauthClientAppData = await oAuthClientAppDB.findOne({ oauthClientAppId });
    const oauthClientId = oauthClientAppData.clientId;

    let oauthRoleId;
    let existingOauthRoleId;
    
    do {
      oauthRoleId = `${oauthClientAppId}-${[...Array(4)].map(() => Math.random().toString(36).charAt(2)).join('')}`;
      existingOauthRoleId = await oAuthRolesDB.findOne({ oauthRoleId: oauthRoleId });
    } while (existingOauthRoleId);

    const existingOauthRoleName = await oAuthRolesDB.findOne({ oauthRoleName: oauthRoleName, oauthClientId: oauthClientId });
    if (existingOauthRoleName) {
      return res.status(463).json({ error: 'Role name already exists' });
    }
    
    const newOauthRole = new oAuthRolesDB({
      oauthRoleId: oauthRoleId,
      oauthClientAppId: oauthClientAppId,
      oauthRoleName: oauthRoleName,
      oauthClientId: oauthClientId,
    });

    await newOauthRole.save();

    await oAuthClientAppDB.updateOne({ oauthClientAppId }, { $push: { oauthRoleIds: oauthRoleId } });

    res.status(200).json({ success: true, message: 'OAuth role has been successfully added'});
  } catch (error) {
    res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});


// Update oauth app role
app.post('/api/oauth/settings/roles/update', async (req, res) => {
  const req_cookies = req.headers.cookie;
  const oauthClientAppId = req.body.oauthClientAppId;
  const oauthRoleId = req.body.oauthRoleId;
  let oauthRoleUserIds = req.body.oauthRoleUserIds;

  if (!oauthRoleUserIds) {
    return res.status(400).json({ success: false, error: 'oauthRoleUserIds not provided' });
  }

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

    const userAccess = await userDB.findOne({ userId: userId, sid: sid, providerRoles: 'oauthUser'});

    if (!userAccess) {
      return res.status(460).json({ error: 'User has no permissions to manage oauth apps' });
    }

    let oauthApps = userData.oauthClientAppIds || [];

    if (!Array.isArray(oauthApps)) {
      return res.status(400).json({ error: 'Invalid format for oauthApps' });
    }

    if (oauthApps.length === 0) {
      return res.status(404).json({ error: 'No oAuth apps found for this user' });
    }

    if (oauthApps.indexOf(oauthClientAppId) === -1) {
      return res.status(461).json({ error: 'User does not have access to this oauth app' });
    }

    if (oauthRoleUserIds === '*') {
      oauthRoleUserIds = '*';
    } else {
      const sortedUserIds = oauthRoleUserIds.split(',').map(id => id.trim()).sort();
      oauthRoleUserIds = sortedUserIds;
    }

    const existingRole = await oAuthRolesDB.findOne({ oauthRoleId, oauthClientAppId });
    let updatedUserIds = oauthRoleUserIds;

    if (existingRole && existingRole.oauthUserIds) {
      updatedUserIds = [...existingRole.oauthUserIds, ...oauthRoleUserIds];
    }

    await oAuthRolesDB.findOneAndUpdate(
      { oauthRoleId, oauthClientAppId },
      { oauthRoleId, oauthClientAppId, oauthUserIds: updatedUserIds },
    );

    res.status(200).json({ success: true, message: 'OAuth role has been successfully updated' });
  } catch (error) {
    res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});





// Delete oauth app role
app.post('/api/oauth/settings/roles/delete', async (req, res) => {
  const req_cookies = req.headers.cookie;
  const oauthClientAppId = req.body.oauthClientAppId;
  const oauthRoleId = req.body.oauthRoleId;

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

    const userAccess = await userDB.findOne({ userId: userId, sid: sid, providerRoles: 'oauthUser'});

    if (!userAccess) {
      return res.status(460).json({ error: 'User has no permissions to manage oauth apps' });
    }

    let oauthApps = userData.oauthClientAppIds || [];

    if (!Array.isArray(oauthApps)) {
      return res.status(400).json({ error: 'Invalid format for oauthApps' });
    }

    if (oauthApps.length === 0) {
      return res.status(404).json({ error: 'No oAuth apps found for this user' });
    }

    if (oauthApps.indexOf(oauthClientAppId) === -1) {
      return res.status(461).json({ error: 'User does not have access to this oauth app' });
    }

    await oAuthRolesDB.deleteOne({ oauthRoleId });
    await oAuthClientAppDB.updateOne({ oauthClientAppId }, { $pull: { oauthRoleIds: oauthRoleId } });
    

    res.status(200).json({ success: true, message: 'OAuth role has been successfully deleted'});
  } catch (error) {
    res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Oauth2 authorize endpoint
app.get('/api/oauth/authorize', async (req, res) => {
  const { client_id, state } = req.query;
  const access_token = req.cookies.access_token;
  const clientId = client_id;
  try {
    const oauth_client = await oAuthClientAppDB.findOne({ clientId });
    const redirect_uri = oauth_client.redirectUri;
    if (!oauth_client) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client' });
    }
    jwt.verify(access_token, JWT_SECRET, async (error, decoded) => {
      if (error) {
        return res.redirect(`/login?redirect_uri=${redirect_uri}`);
      }
      const { userId, sid } = decoded;
      const user = await userDB.findOne({ userId, sid });
      if (!user) {
        return res.redirect(`/login?redirect_uri=${redirect_uri}`);
      }
      
      let authorizationCode;
      let existingAuthorizationCode;
      do {
        authorizationCode = [...Array(35)].map(() => Math.random().toString(36)[2]).join('');
        existingAuthorizationCode = await userDB.findOne({ oauthAuthorizationCode: authorizationCode });
      } while (existingAuthorizationCode);
      
      await userDB.updateOne({ userId }, { $set: { oauthAuthorizationCode: authorizationCode } });
      
      const redirectUri = `${redirect_uri}?code=${authorizationCode}&state=${state}`;
      res.redirect(redirectUri);
    });
  } catch (error) {
    res.status(500).json({ error: 'server_error', error_description: 'Server error' });
  }
});



// Oauth Token endpoint
app.post('/api/oauth/token', async (req, res) => {
  const { code, client_id, client_secret, refresh_token } = req.body;
  const clientId = client_id;
  const clientSecret = client_secret;
  const refreshToken = refresh_token;
  try {
    let oauth_client;
    let oauth_user;
    let userId;
    let oauthSid;

    if (refreshToken) {
      const decodedRefreshToken = jwt.verify(refreshToken, JWT_SECRET);
      userId = decodedRefreshToken.userId;
      oauthSid = decodedRefreshToken.oauthSid;

      const refresh_token_clientId = decodedRefreshToken.clientId;

      oauth_client = await oAuthClientAppDB.findOne({ clientId: refresh_token_clientId, clientSecret: clientSecret });
      oauth_user = await userDB.findOne({ userId, oauthSid});

      if (!oauth_client) {
        return res.status(401).json({ error: 'Unauthorized', error_description: 'Invalid client or invalid refresh token' });
      }
      if (!oauth_user) {
        return res.status(401).json({ error: 'Unauthorized', error_description: 'Invalid user credentials' });
      }

      const username = oauth_user.username;
      const email = oauth_user.email;
      const mfaEnabled = oauth_user.mfaEnabled;
      const accessTokenValidity = oauth_client.accessTokenValidity;

      const roleData = await oAuthRolesDB.find({
        $or: [
          { oauthClientId: clientId, oauthUserIds: userId },
          { oauthClientId: clientId, oauthUserIds: "*" },
        ],
      }).exec();
      
      const roleNames = roleData.map(role => role.oauthRoleName);
      
      const oauth_access_token = jwt.sign({ userId: userId, oauthSid: oauthSid, clientId: clientId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: accessTokenValidity });
      const oauth_id_token = jwt.sign({ userId: userId, username: username, email: email, roles: roleNames, mfaEnabled: mfaEnabled }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });
      const oauth_refresh_token = jwt.sign({ userId: userId, oauthSid: oauthSid, clientId: clientId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '20d' });
      return res.json({ access_token: oauth_access_token, id_token: oauth_id_token, refresh_token: oauth_refresh_token });


    } else if (code) {
      oauth_client = await oAuthClientAppDB.findOne({ clientId, clientSecret });
      oauth_user = await userDB.findOne({ oauthAuthorizationCode: code });
      const oauthAuthorizationCode = code;
      await userDB.updateOne({ oauthAuthorizationCode }, { $unset: { oauthAuthorizationCode: 1 } });

      if (!oauth_client) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client' });
      }

      if (!oauth_user) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid authorization code' });
      }
      userId = oauth_user.userId;
      oauthSid = oauth_user.oauthSid;
    } else {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid authorization code' });
    }

    const username = oauth_user.username;
    const email = oauth_user.email;
    const mfaEnabled = oauth_user.mfaEnabled;
    const accessTokenValidity = oauth_client.accessTokenValidity;

    const roleData = await oAuthRolesDB.find({
      $or: [
        { oauthClientId: clientId, oauthUserIds: userId },
        { oauthClientId: clientId, oauthUserIds: "*" },
      ],
    }).exec();

    const roleNames = roleData.map(role => role.oauthRoleName);

    const oauth_access_token = jwt.sign({ userId: userId, oauthSid: oauthSid, clientId: clientId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: accessTokenValidity });
    const oauth_id_token = jwt.sign({ userId: userId, username: username, email: email, roles: roleNames, mfaEnabled: mfaEnabled }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '48h' });
    const oauth_refresh_token = jwt.sign({ userId: userId, oauthSid: oauthSid, clientId: clientId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '20d' });
    return res.json({ access_token: oauth_access_token, id_token: oauth_id_token, refresh_token: oauth_refresh_token });

  } catch (error) {
    res.status(500).json({ error: 'server_error', error_description: 'Server error' });
  }
});




// Added userinfo endpoint
app.post('/api/oauth/userinfo', async (req, res) => {
  let access_token;

  const authorizationHeader = req.headers['authorization'];
  if (authorizationHeader && authorizationHeader.startsWith('Bearer ')) {
    access_token = authorizationHeader.split(' ')[1];
  }

  if (!access_token) {
    const req_cookies = req.headers.cookie;
    
    if (!req_cookies) {
      return res.status(400).json({ success: false, error: 'Access Token not found' });
    }
    
    const cookies = req_cookies.split(';').reduce((cookiesObj, cookie) => {
      const [name, value] = cookie.trim().split('=');
      cookiesObj[name] = value;
      return cookiesObj;
    }, {});

    access_token = cookies['access_token'];
  }

  if (!access_token) {
    return res.status(400).json({ success: false, error: 'Access Token not provided' });
  }

  try {
    const decoded = jwt.verify(access_token, JWT_SECRET);
    const userId = decoded.userId;
    const sid = decoded.sid;
    const oauthSid = decoded.oauthSid;
    const clientId = decoded.clientId;

    const userData = await userDB.findOne({ userId: userId, $or: [{ oauthSid: oauthSid }, { sid: sid }] });
    if (!userData) {
      res.clearCookie('access_token');
      return res.redirect('/login');
    }

    if (!clientId || clientId === 'undefined') {
      return res.status(200).json({
        userId: userId,
        username: userData.username,
        email: userData.email,
        providerRoles: userData.providerRoles,
        mfaEnabled: userData.mfaEnabled
      });
    }

    const roleData = await oAuthRolesDB.find({
      $or: [
        { oauthClientId: clientId, oauthUserIds: userId },
        { oauthClientId: clientId, oauthUserIds: "*" },
      ],
    }).exec();

    const roleNames = roleData.map(role => role.oauthRoleName);

    res.status(200).json({
      userId: userId,
      username: userData.username,
      email: userData.email,
      roles: roleNames,
      mfaEnabled: userData.mfaEnabled
    });
  } catch (error) {
    notifyError(error);
    return res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// Added check_token endpoint
app.post('/api/oauth/check_token', async (req, res) => {
  let access_token;

  const authorizationHeader = req.headers['authorization'];
  if (authorizationHeader && authorizationHeader.startsWith('Bearer ')) {
    access_token = authorizationHeader.split(' ')[1];
  }

  if (!access_token) {
    const req_cookies = req.headers.cookie;
    
    if (!req_cookies) {
      return res.status(400).json({ success: false, error: 'Access Token not found' });
    }
    
    const cookies = req_cookies.split(';').reduce((cookiesObj, cookie) => {
      const [name, value] = cookie.trim().split('=');
      cookiesObj[name] = value;
      return cookiesObj;
    }, {});

    access_token = cookies['access_token'];
  }

  if (!access_token) {
    return res.status(400).json({ success: false, error: 'Access Token not provided' });
  }

  try {
    const decoded = jwt.verify(access_token, JWT_SECRET);
    const userId = decoded.userId;
    const oauthSid = decoded.oauthSid;

    const userData = await userDB.findOne({ userId: userId, oauthSid: oauthSid });
    if (!userData) {
      return res.status(401).json({ success: false, description: 'Access Token is invalid' });
    }

    res.status(200).json({ success: true, description: 'Access Token is valid' });
  } catch (error) {
    notifyError(error);
    return res.status(500).json({ error: 'Something went wrong, try again later' });
  }
});



// OIDC Discovery endpoint
app.get('/.well-known/openid-configuration', (req, res) => {
  const metadata = {
    issuer: `${URL}`,
    authorization_endpoint: `${URL}/api/oauth/authorize`,
    token_endpoint: `${URL}/api/oauth/token`,
    userinfo_endpoint: `${URL}/api/oauth/userinfo`,
    response_types_supported: ['code, token, id_token,'],
    id_token_signing_alg_values_supported: ['HS256'],
    scopes_supported: ["openid"],
    grant_types_supported: ["authorization_code"],
  };
  res.json(metadata);
});



// Send the email verification email
function sendVerificationEmail(username, email, email_verification_token, new_email_verification_code, res) {
  const mailjetConnect = mailjet.apiConnect(MJ_APIKEY_PUBLIC, MJ_APIKEY_PRIVATE);
  const request = mailjetConnect
    .post('send', { version: 'v3.1' })
    .request({
      Messages: [
        {
          From: {
            Email: MJ_SENDER_EMAIL
          },
          To: [
            {
              Email: email
            }
          ],
          Subject: "Your Email Verification Code",
          HtmlPart: `
          <!doctype html>
          <html>
          <head>
            <title></title>
            <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
            <style type="text/css">
              body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
              p { display: block; margin: 13px 0; }
            </style>
          </head>
          <body style="background: #F9F9F9;">
            <div style="background-color: #F9F9F9;">
              <div style="margin: 0px auto; max-width: 640px; background: transparent;">
                <table role="presentation" cellpadding="0" cellspacing="0" style="font-size: 0px; width: 100%; background: transparent;" align="center" border="0">
                  <tbody>
                    <tr>
                      <td style="text-align: center; vertical-align: top; direction: ltr; font-size: 0px; padding: 40px 0px;">
                        <div aria-labelledby="mj-column-per-100" class="mj-column-per-100" style="vertical-align: top; display: inline-block; direction: ltr; font-size: 13px; text-align: left; width: 100%;">
                          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" border="0">
                            <tbody>
                              <tr>
                                <td style="word-break: break-word; font-size: 0px; padding: 0px;" align="center">
                                  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border-spacing: 0px;" align="center" border="0">
                                    <tbody>
                                      <tr>
                                        <td style="width: 138px;"></td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style="max-width: 640px; margin: 0 auto; box-shadow: 0px 1px 5px rgba(0, 0, 0, 0.1); border-radius: 8px; overflow: hidden;">
                <div style="margin: 0px auto; max-width: 640px; background: #ffffff;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="font-size: 0px; width: 100%; background: #ffffff;" align="center" border="0">
                    <tbody>
                      <tr>
                        <td style="text-align: center; vertical-align: top; direction: ltr; font-size: 0px; padding: 40px 50px;">
                          <div aria-labelledby="mj-column-per-100" class="mj-column-per-100" style="vertical-align: top; display: inline-block; direction: ltr; font-size: 13px; text-align: left; width: 100%;">
                            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" border="0">
                              <tbody>
                                <tr>
                                  <td style="word-break: break-word; font-size: 0px; padding: 0px;" align="left">
                                    <div style="cursor: auto; color: #737F8D; font-family: Helvetica Neue, Helvetica, Arial, Lucida Grande, sans-serif; font-size: 16px; line-height: 24px; text-align: left;">
                                      <h2 style="font-family: Helvetica Neue, Helvetica, Arial, Lucida Grande, sans-serif; font-weight: 500; font-size: 20px; color: #4F545C; letter-spacing: 0.27px;">Hey ${username},</h2>
                                      <p>Your account email needs to get verified before you can use your account. Don't share this code with anyone! Please enter the following code or click on this <a href=${URL}/api/sso/confirmationlink/${email_verification_token}/${new_email_verification_code}>Link</a> to verify your email:</p>
                                    </div>
                                  </td>
                                </tr>
                                <tr>
                                  <td style="word-break: break-word; font-size: 0px; padding: 10px 25px; padding-top: 20px;" align="center">
                                    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: separate;" align="center" border="0">
                                      <tbody>
                                        <tr>
                                          <td style="border: none; border-radius: 8px; cursor: auto; padding: 15px 105px;" align="center" valign="middle" bgcolor="#5865f2">
                                            <p style="font-size: 30px; font-family: Helvetica Neue, Helvetica, Arial, Lucida Grande, sans-serif;">${new_email_verification_code}</p>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div style="margin: 0px auto; max-width: 640px; background: transparent;">
                <table role="presentation" cellpadding="0" cellspacing="0" style="font-size: 0px; width: 100%; background: transparent;" align="center" border="0">
                  <tbody>
                    <tr>
                      <td style="text-align: center; vertical-align: top; direction: ltr; font-size: 0px; padding: 20px 0px;">
                        <div aria-labelledby="mj-column-per-100" class="mj-column-per-100" style="vertical-align: top; display: inline-block; direction: ltr; font-size: 13px; text-align: left; width: 100%;">
                          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" border="0">
                            <tbody>
                              <tr>
                                <td style="word-break: break-word; font-size: 0px; padding: 0px;" align="center">
                                  <div style="cursor: auto; color: #99AAB5; font-family: Helvetica Neue, Helvetica, Arial, Lucida Grande, sans-serif; font-size: 12px; line-height: 24px; text-align: center;">
                                    Sent by Onedns
                                  </div>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </body>
          </html>
          `
        }
      ]
    });
  request.then(() => {
  }).catch((error) => {
    notifyError(error);
  });
}



// Send the password recovery email
function sendRecoveryEmail(username, email, password_reset_token, password_reset_code, res) {
  const mailjetConnect = mailjet.apiConnect(MJ_APIKEY_PUBLIC, MJ_APIKEY_PRIVATE);
  const request = mailjetConnect
    .post('send', { version: 'v3.1' })
    .request({
      Messages: [
        {
          From: {
            Email: MJ_SENDER_EMAIL
          },
          To: [
            {
              Email: email
            }
          ],
          Subject: "Your Email Verification Code",
          HtmlPart: `
          <!doctype html>
          <html>
          <head>
            <title></title>
            <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
            <style type="text/css">
              body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
              p { display: block; margin: 13px 0; }
            </style>
          </head>
          <body style="background: #F9F9F9;">
            <div style="background-color: #F9F9F9;">
              <div style="margin: 0px auto; max-width: 640px; background: transparent;">
                <table role="presentation" cellpadding="0" cellspacing="0" style="font-size: 0px; width: 100%; background: transparent;" align="center" border="0">
                  <tbody>
                    <tr>
                      <td style="text-align: center; vertical-align: top; direction: ltr; font-size: 0px; padding: 40px 0px;">
                        <div aria-labelledby="mj-column-per-100" class="mj-column-per-100" style="vertical-align: top; display: inline-block; direction: ltr; font-size: 13px; text-align: left; width: 100%;">
                          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" border="0">
                            <tbody>
                              <tr>
                                <td style="word-break: break-word; font-size: 0px; padding: 0px;" align="center">
                                  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border-spacing: 0px;" align="center" border="0">
                                    <tbody>
                                      <tr>
                                        <td style="width: 138px;"></td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style="max-width: 640px; margin: 0 auto; box-shadow: 0px 1px 5px rgba(0, 0, 0, 0.1); border-radius: 8px; overflow: hidden;">
                <div style="margin: 0px auto; max-width: 640px; background: #ffffff;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="font-size: 0px; width: 100%; background: #ffffff;" align="center" border="0">
                    <tbody>
                      <tr>
                        <td style="text-align: center; vertical-align: top; direction: ltr; font-size: 0px; padding: 40px 50px;">
                          <div aria-labelledby="mj-column-per-100" class="mj-column-per-100" style="vertical-align: top; display: inline-block; direction: ltr; font-size: 13px; text-align: left; width: 100%;">
                            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" border="0">
                              <tbody>
                                <tr>
                                  <td style="word-break: break-word; font-size: 0px; padding: 0px;" align="left">
                                    <div style="cursor: auto; color: #737F8D; font-family: Helvetica Neue, Helvetica, Arial, Lucida Grande, sans-serif; font-size: 16px; line-height: 24px; text-align: left;">
                                      <h2 style="font-family: Helvetica Neue, Helvetica, Arial, Lucida Grande, sans-serif; font-weight: 500; font-size: 20px; color: #4F545C; letter-spacing: 0.27px;">Hey ${username},</h2>
                                      <p>You requested to reset your password. Please enter the following code or click on this <a href=${URL}/api/sso/setresettokens/${password_reset_token}/${password_reset_code}>Link</a> to reset your password:</p>
                                    </div>
                                  </td>
                                </tr>
                                <tr>
                                  <td style="word-break: break-word; font-size: 0px; padding: 10px 25px; padding-top: 20px;" align="center">
                                    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: separate;" align="center" border="0">
                                      <tbody>
                                        <tr>
                                          <td style="border: none; border-radius: 8px; cursor: auto; padding: 15px 105px;" align="center" valign="middle" bgcolor="#5865f2">
                                            <p style="font-size: 30px; font-family: Helvetica Neue, Helvetica, Arial, Lucida Grande, sans-serif;">${password_reset_code}</p>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div style="margin: 0px auto; max-width: 640px; background: transparent;">
                <table role="presentation" cellpadding="0" cellspacing="0" style="font-size: 0px; width: 100%; background: transparent;" align="center" border="0">
                  <tbody>
                    <tr>
                      <td style="text-align: center; vertical-align: top; direction: ltr; font-size: 0px; padding: 20px 0px;">
                        <div aria-labelledby="mj-column-per-100" class="mj-column-per-100" style="vertical-align: top; display: inline-block; direction: ltr; font-size: 13px; text-align: left; width: 100%;">
                          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" border="0">
                            <tbody>
                              <tr>
                                <td style="word-break: break-word; font-size: 0px; padding: 0px;" align="center">
                                  <div style="cursor: auto; color: #99AAB5; font-family: Helvetica Neue, Helvetica, Arial, Lucida Grande, sans-serif; font-size: 12px; line-height: 24px; text-align: center;">
                                    Sent by Onedns
                                  </div>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </body>
          </html>
          `
        }
      ]
    });
  request.then(() => {
  }).catch((error) => {
    notifyError(error);
  });
}



// Notify when database error occurs.
function notifyError(error) {
  const params = {
    content: `ALERT: DATABASE ERROR: ${error}`
  };
  fetch(DC_MONITORING_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  }).catch((error) => {
    console.error('Interet, or Webhook URL error:', error);
  });
}



// Notify when user logs in
function notifyLogin(username) {
  const params = {
    content: `User with Username: ${username} has just logged in!`
  };
  fetch(DC_MONITORING_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  }).catch((error) => {
    console.error('Interet, or Webhook URL error:', error);
  });
}



// Notify when user has registered
function notifyRegister(username) {
  const params = {
    content: `User with Username: ${username} has just registered!`
  };
  fetch(DC_MONITORING_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  }).catch((error) => {
    console.error('Interet, or Webhook URL error:', error);
  });
}



// Check the health of the application
app.get('/api/health', async (req, res) => {
  try {
    const collection = db.collection('users'); 
    const result = await collection.findOne({});
    const error = "Database connection error, or not initialized."
    if (!result) {
      notifyError(error);
      return res.status(500).json({ error: error });
    }
    const response = await fetch('https://google.com', { method: 'GET' });
    if (!response.ok) {
      notifyError();
      return res.status(500).json({ error: 'Application has no connection to the internet' });
    }
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    notifyError(error);
    res.status(500).json({ error: 'Application has encountered an error:', error });
  } finally {
  }
});



// Start the api
app.listen(API_PORT, () => {
  console.log('Login API started on port', API_PORT);
});