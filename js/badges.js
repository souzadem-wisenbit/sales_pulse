// ================================================
// SALESPULSE — Badge & Ranking System
// ================================================

const BadgeSystem = (() => {

  const BADGE_DEFS = [
    {
      id: 'rapport_master',
      name: 'Mestre do Rapport',
      emoji: '🤝',
      desc: 'Pontuou 85+ em Rapport em uma sessão',
      color: '#6c63ff',
      rarity: 'gold',
      check: (result) => (result.scores?.rapport || 0) >= 85,
    },
    {
      id: 'objection_hunter',
      name: 'Caçador de Objeções',
      emoji: '🛡️',
      desc: 'Pontuou 85+ em Manejo de Objeções em uma sessão',
      color: '#ff4757',
      rarity: 'gold',
      check: (result) => (result.scores?.objections || 0) >= 85,
    },
    {
      id: 'closer',
      name: 'Fechador de Oportunidades',
      emoji: '🎯',
      desc: 'Convenceu o cliente com score ≥ 80',
      color: '#2ed573',
      rarity: 'gold',
      check: (result) => result.convinced && (result.total || 0) >= 80,
    },
    {
      id: 'followup_king',
      name: 'Rei do Follow-up',
      emoji: '👑',
      desc: 'Definiu próximo passo concreto em 3 sessões consecutivas',
      color: '#ffd700',
      rarity: 'diamond',
      check: (result, allSessions) => {
        if ((result.scores?.closing || 0) < 70) return false;
        const valid = allSessions.filter(s => (s.result?.scores?.closing || 0) >= 70);
        return valid.length >= 3;
      },
    },
    {
      id: 'high_conversion',
      name: 'Técnico de Alta Conversão',
      emoji: '⚡',
      desc: 'Score total ≥ 90 em qualquer sessão',
      color: '#00d4aa',
      rarity: 'diamond',
      check: (result) => (result.total || 0) >= 90,
    },
    {
      id: 'agenda_discoverer',
      name: 'Descobridor de Agendas',
      emoji: '🕵️',
      desc: 'Descobriu a agenda oculta do cliente',
      color: '#a29bfe',
      rarity: 'silver',
      check: (result) => !!result.hiddenAgendaRevealed,
    },
    {
      id: 'hostile_survivor',
      name: 'Sobrevivente do Mercado Hostil',
      emoji: '🔥',
      desc: 'Completou sessão em modo Mercado Hostil com score ≥ 60',
      color: '#fd9644',
      rarity: 'gold',
      check: (result, _, config) => (config?.hostileMode) && (result.total || 0) >= 60,
    },
    {
      id: 'value_presenter',
      name: 'Apresentador de Valor',
      emoji: '💡',
      desc: 'Pontuou 90+ em Apresentação de Valor',
      color: '#eccc68',
      rarity: 'silver',
      check: (result) => (result.scores?.value || 0) >= 90,
    },
    {
      id: 'discovery_expert',
      name: 'Expert em Diagnóstico',
      emoji: '🔍',
      desc: 'Pontuou 90+ em Levantamento de Necessidades',
      color: '#70a1ff',
      rarity: 'silver',
      check: (result) => (result.scores?.discovery || 0) >= 90,
    },
    {
      id: 'consistent_pro',
      name: 'Profissional Consistente',
      emoji: '📈',
      desc: 'Realizou 10 sessões com score médio ≥ 65',
      color: '#a4b0be',
      rarity: 'gold',
      check: (result, allSessions) => {
        if (allSessions.length < 10) return false;
        const avg = allSessions.reduce((s, ss) => s + (ss.result?.total || 0), 0) / allSessions.length;
        return avg >= 65;
      },
    },
    {
      id: 'persuation_master',
      name: 'Mestre da Persuasão',
      emoji: '🧲',
      desc: 'Usou 5+ gatilhos de persuasão distintos em uma sessão',
      color: '#fd79a8',
      rarity: 'gold',
      check: (result) => {
        const triggers = result.triggerUsage || {};
        const active = Object.values(triggers).filter(v => v >= 2).length;
        return active >= 5;
      },
    },
    {
      id: 'xray_clean',
      name: 'Comunicação Cristalina',
      emoji: '💎',
      desc: 'Raio-X sem vícios de linguagem e sem palavras fracas',
      color: '#b9f2ff',
      rarity: 'diamond',
      check: (result) => {
        const xray = result.styleXray;
        if (!xray) return false;
        return xray.vicesCount === 0 && xray.weakWordsCount === 0 && xray.openQuestionRatio >= 0.5;
      },
    },
  ];

  const RARITY_ORDER = { bronze: 0, silver: 1, gold: 2, diamond: 3 };

  // Storage key
  const STORAGE_KEY = 'sbp_badges';

  function getAllBadges() { return BADGE_DEFS; }

  function getUserBadges(userId) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const all = raw ? JSON.parse(raw) : {};
      return all[userId] || [];
    } catch { return []; }
  }

  function saveUserBadges(userId, badges) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const all = raw ? JSON.parse(raw) : {};
      all[userId] = badges;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {}
  }

  // Check which badges are newly earned from this session result
  function checkNewBadges(result, allSessions, config, userId) {
    const existing = getUserBadges(userId).map(b => b.id);
    const newlyEarned = [];

    BADGE_DEFS.forEach(def => {
      if (existing.includes(def.id)) return; // already earned
      try {
        if (def.check(result, allSessions, config)) {
          newlyEarned.push({
            id: def.id,
            name: def.name,
            emoji: def.emoji,
            desc: def.desc,
            color: def.color,
            rarity: def.rarity,
            earnedAt: new Date().toISOString(),
            sessionScore: result.total,
          });
        }
      } catch {}
    });

    if (newlyEarned.length > 0) {
      const updated = [...getUserBadges(userId), ...newlyEarned];
      saveUserBadges(userId, updated);
    }

    return newlyEarned;
  }

  // Render badge grid HTML
  function renderBadgeGrid(badges, compact = false) {
    if (!badges || badges.length === 0) {
      return `<div class="badge-empty">Nenhuma conquista ainda. Continue treinando! 🚀</div>`;
    }

    const sorted = [...badges].sort((a, b) =>
      (RARITY_ORDER[b.rarity] || 0) - (RARITY_ORDER[a.rarity] || 0)
    );

    return `<div class="badges-grid ${compact ? 'badges-grid-compact' : ''}">
      ${sorted.map(b => `
        <div class="badge-card badge-rarity-${b.rarity}" title="${b.desc}">
          <div class="badge-emoji">${b.emoji}</div>
          ${!compact ? `
            <div class="badge-name">${b.name}</div>
            <div class="badge-desc">${b.desc}</div>
          ` : ''}
          <div class="badge-rarity-label">${{ bronze: 'Bronze', silver: 'Prata', gold: 'Ouro', diamond: 'Diamante' }[b.rarity] || ''}</div>
        </div>
      `).join('')}
    </div>`;
  }

  // Render new badges earned popup content
  function renderNewBadgesPopup(newBadges) {
    if (!newBadges || newBadges.length === 0) return '';
    return `
      <div class="new-badges-popup">
        <div class="new-badges-title">🎉 Nova${newBadges.length > 1 ? 's' : ''} Conquista${newBadges.length > 1 ? 's' : ''}!</div>
        ${newBadges.map(b => `
          <div class="new-badge-item badge-rarity-${b.rarity}">
            <span class="badge-emoji">${b.emoji}</span>
            <div>
              <div class="badge-name">${b.name}</div>
              <div class="badge-desc">${b.desc}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // Calculate seller rank points
  function calcRankPoints(sessions) {
    return sessions.reduce((total, s) => {
      const score = s.result?.total || 0;
      const bonus = s.result?.convinced ? 10 : 0;
      const hostileBonus = s.config?.hostileMode ? 15 : 0;
      return total + score + bonus + hostileBonus;
    }, 0);
  }

  // Get rank tier from points
  function getRankTier(points) {
    if (points < 200)  return { name: 'Rookie',       emoji: '🥚', color: '#a4b0be' };
    if (points < 500)  return { name: 'Aprendiz',     emoji: '🌱', color: '#2ed573' };
    if (points < 1000) return { name: 'Profissional', emoji: '⚡', color: '#70a1ff' };
    if (points < 2000) return { name: 'Especialista', emoji: '🎯', color: '#ffd700' };
    if (points < 4000) return { name: 'Elite',        emoji: '💎', color: '#b9f2ff' };
    return                      { name: 'Lendário',    emoji: '🔥', color: '#ff6b6b' };
  }

  return {
    getAllBadges,
    getUserBadges,
    checkNewBadges,
    renderBadgeGrid,
    renderNewBadgesPopup,
    calcRankPoints,
    getRankTier,
    BADGE_DEFS,
  };
})();
