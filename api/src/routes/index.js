'use strict';
const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { validate, schemas } = require('../middleware/validate');
const usersCtrl = require('../controllers/usersController');
const scenariosCtrl = require('../controllers/scenariosController');
const sessionsCtrl = require('../controllers/sessionsController');
const syncCtrl = require('../controllers/syncController');
const clientsCtrl = require('../controllers/clientsController');
const productsCtrl = require('../controllers/productsController');
const schedCtrl = require('../controllers/scheduledSessionsController');
const liveCtrl = require('../controllers/liveCallsController');
const waCtrl = require('../controllers/whatsappController');
const knowCtrl = require('../controllers/knowledgeController');

const syncRouter = express.Router();
syncRouter.use(authenticate);
syncRouter.get('/', authorize('manager', 'seller'), syncCtrl.getSync);
syncRouter.post('/', authorize('manager'), syncCtrl.postSync);

const clientsRouter = express.Router();
clientsRouter.use(authenticate);
clientsRouter.get('/', authorize('manager', 'seller'), clientsCtrl.listClients);
clientsRouter.post('/', authorize('manager'), clientsCtrl.createClient);
clientsRouter.put('/:id', authorize('manager'), clientsCtrl.updateClient);
clientsRouter.delete('/:id', authorize('manager'), clientsCtrl.deleteClient);

const productsRouter = express.Router();
productsRouter.use(authenticate);
productsRouter.get('/', authorize('manager', 'seller'), productsCtrl.listProducts);
productsRouter.post('/', authorize('manager'), productsCtrl.createProduct);
productsRouter.put('/:id', authorize('manager'), productsCtrl.updateProduct);
productsRouter.delete('/:id', authorize('manager'), productsCtrl.deleteProduct);

const scheduledRouter = express.Router();
scheduledRouter.use(authenticate);
scheduledRouter.get('/', authorize('manager', 'seller'), schedCtrl.listScheduledSessions);
scheduledRouter.post('/', authorize('manager'), schedCtrl.createScheduledSession);
scheduledRouter.put('/:id', authorize('manager', 'seller'), schedCtrl.updateScheduledSession);
scheduledRouter.delete('/:id', authorize('manager'), schedCtrl.deleteScheduledSession);

const usersRouter = express.Router();
usersRouter.use(authenticate);
usersRouter.get('/', authorize('manager', 'seller'), usersCtrl.listUsers);
usersRouter.post('/', authorize('manager'), validate(schemas.createUser), usersCtrl.createUser);
usersRouter.put('/:id', authorize('manager'), validate(schemas.updateUser), usersCtrl.updateUser);
usersRouter.delete('/:id', authorize('manager'), usersCtrl.deleteUser);

const scenariosRouter = express.Router();
scenariosRouter.use(authenticate);
scenariosRouter.get('/', authorize('manager', 'seller'), scenariosCtrl.listScenarios);
scenariosRouter.post('/', authorize('manager'), scenariosCtrl.createScenario);
scenariosRouter.put('/:id', authorize('manager'), scenariosCtrl.updateScenario);

const multer = require('multer');
const upload = multer();

const sessionsRouter = express.Router();
sessionsRouter.use(authenticate);
sessionsRouter.get('/', authorize('manager', 'seller'), sessionsCtrl.listSessions);
sessionsRouter.post('/', authorize('manager', 'seller'), sessionsCtrl.startSession);
sessionsRouter.post('/transcribe', authorize('manager', 'seller'), upload.single('audio'), sessionsCtrl.transcribeAudio);
sessionsRouter.post('/:id/message', authorize('manager', 'seller'), sessionsCtrl.sendMessage);
sessionsRouter.put('/:id/end', authorize('manager', 'seller'), sessionsCtrl.endSession);
sessionsRouter.post('/:id/evaluate', authorize('manager', 'seller'), sessionsCtrl.evaluateSession);
sessionsRouter.post('/:id/coach', authorize('manager', 'seller'), sessionsCtrl.getCoachTip);

const liveCallsRouter = express.Router();
liveCallsRouter.use(authenticate);
liveCallsRouter.get('/', authorize('manager', 'seller'), liveCtrl.listLiveCalls);
liveCallsRouter.post('/', authorize('manager', 'seller'), liveCtrl.createLiveCall);
liveCallsRouter.get('/:id', authorize('manager', 'seller'), liveCtrl.getLiveCall);
liveCallsRouter.put('/:id', authorize('manager', 'seller'), liveCtrl.updateLiveCall);

const liveProfilesRouter = express.Router();
liveProfilesRouter.use(authenticate);
liveProfilesRouter.get('/', authorize('manager'), liveCtrl.listProfiles);
liveProfilesRouter.get('/:userId', authorize('manager', 'seller'), liveCtrl.getProfile);
liveProfilesRouter.put('/:userId', authorize('manager', 'seller'), liveCtrl.upsertProfile);
liveProfilesRouter.put('/:userId/coach', authorize('manager'), liveCtrl.assignCoach);

// Conhecimento do coach: gestor sobe documentos de metodologia; o Live Coach
// (áudio e WhatsApp) busca os trechos relevantes a cada dica via /retrieve.
const uploadDoc = multer({ limits: { fileSize: 30 * 1024 * 1024 } });
const knowledgeRouter = express.Router();
knowledgeRouter.use(authenticate);
knowledgeRouter.get('/docs', authorize('manager'), knowCtrl.listDocs);
knowledgeRouter.post('/docs', authorize('manager'), uploadDoc.single('file'), knowCtrl.uploadDoc);
knowledgeRouter.delete('/docs/:id', authorize('manager'), knowCtrl.deleteDoc);
knowledgeRouter.post('/retrieve', authorize('manager', 'seller'), knowCtrl.retrieveChunks);
knowledgeRouter.get('/core', authorize('manager', 'seller'), knowCtrl.getCore);

// WhatsApp Coach: sessão SEMPRE do próprio usuário autenticado (req.user.id).
// Nenhuma rota aceita userId de fora — um vendedor não alcança o WhatsApp de outro.
const whatsappRouter = express.Router();
whatsappRouter.use(authenticate);
whatsappRouter.post('/connect', authorize('manager', 'seller'), waCtrl.connectWhatsapp);
whatsappRouter.get('/status', authorize('manager', 'seller'), waCtrl.getStatus);
whatsappRouter.get('/events', authorize('manager', 'seller'), waCtrl.getEvents);
whatsappRouter.post('/disconnect', authorize('manager', 'seller'), waCtrl.disconnectWhatsapp);
whatsappRouter.get('/briefing', authorize('manager', 'seller'), waCtrl.getBriefing);
whatsappRouter.put('/briefing', authorize('manager', 'seller'), waCtrl.putBriefing);

module.exports = { usersRouter, scenariosRouter, sessionsRouter, syncRouter, clientsRouter, productsRouter, scheduledRouter, liveCallsRouter, liveProfilesRouter, whatsappRouter, knowledgeRouter };
