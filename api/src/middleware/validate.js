'use strict';
const Joi = require('joi');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const data = req[source];
    const { error, value } = schema.validate(data, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const messages = error.details.map(d => d.message).join('; ');
      return res.status(400).json({ error: `Dados inválidos: ${messages}` });
    }

    req[source] = value;
    next();
  };
}

const schemas = {
  login: Joi.object({
    email:    Joi.string().email().max(255).required().lowercase().trim(),
    password: Joi.string().min(1).max(200).required(),
  }),

  createUser: Joi.object({
    name:         Joi.string().min(2).max(100).required().trim(),
    email:        Joi.string().email().max(255).required().lowercase().trim(),
    password:     Joi.string().min(6).max(200).required(),
    role:         Joi.string().valid('manager', 'seller', 'superadmin').default('seller'),
    avatar_emoji: Joi.string().max(10).allow('', null).default('👤'),
    manager_id:   Joi.string().uuid().allow('', null).optional(),
  }),

  updateUser: Joi.object({
    name:         Joi.string().min(2).max(100).trim(),
    email:        Joi.string().email().max(255).lowercase().trim(),
    password:     Joi.string().min(6).max(200),
    avatar_emoji: Joi.string().max(10).allow('', null),
    status:       Joi.string().valid('active', 'suspended'),
    manager_id:   Joi.string().uuid().allow('', null).optional(),
  }),
};

module.exports = { validate, schemas };
