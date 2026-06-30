'use strict';
const express = require('express');
const { validate, schemas } = require('../middleware/validate');
const authCtrl = require('../controllers/authController');

const router = express.Router();

router.post('/login', validate(schemas.login), authCtrl.login);

module.exports = router;
