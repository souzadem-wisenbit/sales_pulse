'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const { usersRouter, scenariosRouter, sessionsRouter, syncRouter, clientsRouter, productsRouter, scheduledRouter } = require('./routes/index');

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/sync', syncRouter);
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRouter);
app.use('/api/scenarios', scenariosRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/products', productsRouter);
app.use('/api/scheduled_sessions', scheduledRouter);

// Basic health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', environment: process.env.NODE_ENV });
});

// Serve static frontend files from the root of the project
const path = require('path');
const frontendPath = path.join(__dirname, '..', '..');
app.use(express.static(frontendPath));

// Fallback for frontend routing (SPA)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// 404 for API routes
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('[APP ERROR]', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

module.exports = app;
