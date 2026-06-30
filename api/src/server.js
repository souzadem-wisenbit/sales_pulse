'use strict';
const app = require('./app');

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`[SERVER] SalesPulse Single-Tenant rodando na porta ${PORT}`);
  console.log(`[SERVER] Ambiente: ${process.env.NODE_ENV}`);
});
