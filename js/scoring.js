// ================================================
// SALESPULSE — Scoring Engine
// ================================================

const ScoringEngine = (() => {

  // ── Calculate weighted total score ──
  function calculateTotal(scores, weights) {
    const defaultWeights = {
      rapport: 15, discovery: 20, value: 20,
      objections: 25, closing: 15, professionalism: 5
    };
    const w = { ...defaultWeights, ...weights };
    const total = Object.keys(w).reduce((sum, key) => {
      return sum + ((scores[key] || 0) * w[key]) / 100;
    }, 0);
    return Math.round(total);
  }

  // ── Get badge based on score ──
  function getBadge(score, convinced) {
    if (!convinced && score < 50) return { level: 'failed', label: 'Não Convenceu', emoji: '💔', color: '#ff4757' };
    if (score < 50) return { level: 'failed', label: 'Abaixo do Esperado', emoji: '😞', color: '#ff4757' };
    if (score < 65) return { level: 'bronze', label: 'Vendedor Bronze', emoji: '🥉', color: '#cd7f32' };
    if (score < 78) return { level: 'silver', label: 'Vendedor Prata', emoji: '🥈', color: '#a8a8c0' };
    if (score < 90) return { level: 'gold', label: 'Vendedor Ouro', emoji: '🥇', color: '#ffd700' };
    return { level: 'diamond', label: 'Vendedor Diamante', emoji: '💎', color: '#b9f2ff' };
  }

  // ── Get score ring color ──
  function getScoreColor(score) {
    if (score < 40) return '#ff4757';
    if (score < 60) return '#ffa502';
    if (score < 75) return '#ffd700';
    if (score < 88) return '#00d4aa';
    return '#6c63ff';
  }

  // ── Get criteria label ──
  function getCriteriaLabel(key) {
    const labels = {
      rapport:         { label: 'Rapport & Abertura', icon: '🤝', desc: 'Criação de conexão e confiança inicial' },
      discovery:       { label: 'Levantamento de Necessidades', icon: '🔍', desc: 'Identificação dos problemas e dores do cliente' },
      value:           { label: 'Apresentação de Valor', icon: '💡', desc: 'Comunicação clara dos benefícios' },
      objections:      { label: 'Manejo de Objeções', icon: '🛡️', desc: 'Tratamento de resistências e dúvidas' },
      closing:         { label: 'Técnicas de Fechamento', icon: '🎯', desc: 'Condução natural ao fechamento' },
      professionalism: { label: 'Profissionalismo', icon: '⭐', desc: 'Tom, linguagem e postura profissional' },
    };
    return labels[key] || { label: key, icon: '📊', desc: '' };
  }

  // ── Format session stats ──
  function formatSessionStats(session) {
    const duration = session.durationSeconds || 0;
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    return {
      duration: `${minutes}:${String(seconds).padStart(2, '0')}`,
      messageCount: session.messages?.length || 0,
      userMessages: session.messages?.filter(m => m.role === 'user').length || 0,
      trickCount: session.messages?.filter(m => m.isTrick).length || 0,
    };
  }

  // ── Generate skill improvement tips ──
  function generateTips(scores) {
    const tips = [];
    const sorted = Object.entries(scores).sort((a, b) => a[1] - b[1]);

    sorted.slice(0, 2).forEach(([key, score]) => {
      const info = getCriteriaLabel(key);
      if (score < 60) {
        const tipBank = {
          rapport: [
            'Comece com uma pergunta aberta sobre o negócio do cliente antes de apresentar seu produto.',
            'Encontre pontos em comum: mencione o setor, desafios similares de outros clientes.',
            'Personalize a abordagem usando o nome do cliente e detalhes específicos da empresa.',
          ],
          discovery: [
            'Use a técnica SPIN: Situação, Problema, Implicação, Necessidade-Solução.',
            'Faça pelo menos 3 perguntas abertas antes de qualquer apresentação.',
            'Explore as consequências do problema atual antes de apresentar a solução.',
          ],
          value: [
            'Conecte cada benefício a uma dor específica mencionada pelo cliente.',
            'Use dados concretos: porcentagens, cases de sucesso, ROI estimado.',
            'Evite features genéricas. Foque no resultado que o cliente terá.',
          ],
          objections: [
            'Use a técnica "Confirmar + Validar + Responder": reconheça a objeção, valide-a e só então responda.',
            'Nunca confronte diretamente. Reforme a objeção como pergunta.',
            'Prepare respostas para as 5 objeções mais comuns do seu produto.',
          ],
          closing: [
            'Identifique sinais de compra (perguntas sobre prazo, implementação, etc.) e aja.',
            'Use fechamentos alternativos: "Prefere começar pelo plano mensal ou anual?"',
            'Defina sempre um próximo passo concreto ao final da conversa.',
          ],
          professionalism: [
            'Evite jargões e termos técnicos desnecessários.',
            'Mantenha um ritmo adequado: não apresse nem arraste a conversa.',
            'Escute mais do que fala. Relação ideal: 30% falando, 70% ouvindo.',
          ],
        };
        const tipList = tipBank[key] || [];
        if (tipList.length) {
          tips.push({ area: info.label, tip: tipList[Math.floor(Math.random() * tipList.length)] });
        }
      }
    });

    return tips;
  }

  // ── Analyze seller language (Raio-X) ──
  function buildStyleXray(userMessages) {
    const texts = userMessages.map(m => m.content || '');
    const fullText = texts.join(' ').toLowerCase();

    // Vícios de linguagem
    const vicePatterns = [
      { pattern: /\bné\b/g, label: '"né" em excesso' },
      { pattern: /\btipo assim\b/g, label: '"tipo assim"' },
      { pattern: /\bentendeu\?/g, label: '"entendeu?" repetido' },
      { pattern: /\bsabe\?/g, label: '"sabe?" repetido' },
      { pattern: /\bcerto\?/g, label: '"certo?" repetido' },
      { pattern: /\bem termos de\b/g, label: '"em termos de" (burocrático)' },
      { pattern: /\bbasicamente\b/g, label: '"basicamente" como muleta' },
      { pattern: /\bou seja\b/g, label: '"ou seja" redundante' },
      { pattern: /\bna verdade\b/g, label: '"na verdade" (fragiliza)' },
    ];

    const vicesFound = [];
    vicePatterns.forEach(({ pattern, label }) => {
      const matches = fullText.match(pattern);
      if (matches && matches.length >= 2) {
        vicesFound.push({ label, count: matches.length });
      }
    });

    // Palavras fracas
    const weakWordPatterns = [
      /\btalvez\b/g, /\bquem sabe\b/g, /\bpode ser que\b/g,
      /\bnão tenho certeza\b/g, /\bacho que\b/g, /\bpossível que\b/g,
      /\btento\b/g, /\bum pouco\b/g
    ];
    let weakWordsCount = 0;
    const weakWordsFound = [];
    weakWordPatterns.forEach(pattern => {
      const matches = fullText.match(pattern);
      if (matches) {
        weakWordsCount += matches.length;
        weakWordsFound.push(matches[0]);
      }
    });

    // Perguntas abertas vs fechadas
    let openQuestions = 0;
    let closedQuestions = 0;
    texts.forEach(text => {
      const questions = text.match(/[^.!?]*\?/g) || [];
      questions.forEach(q => {
        const lower = q.toLowerCase().trim();
        if (/^(o que|como|por que|qual|quais|quando|onde|de que forma|me conta|poderia|pode me dizer|me explica)/.test(lower)) {
          openQuestions++;
        } else {
          closedQuestions++;
        }
      });
    });

    const totalQuestions = openQuestions + closedQuestions;
    const openQuestionRatio = totalQuestions > 0 ? openQuestions / totalQuestions : 0;

    // Repetição de argumentos
    const argumentKeywords = {};
    ['roi', 'retorno', 'produtiv', 'economiz', 'result', 'benefício', 'vantag', 'diferenci'].forEach(kw => {
      const count = (fullText.match(new RegExp(kw, 'g')) || []).length;
      if (count >= 3) argumentKeywords[kw] = count;
    });

    // Excesso de monólogos (mensagens muito longas)
    const avgLength = texts.reduce((s, t) => s + t.length, 0) / Math.max(texts.length, 1);
    const longMessages = texts.filter(t => t.length > 400).length;

    // Score do Raio-X (0-100, maior = melhor)
    let xrayScore = 100;
    xrayScore -= vicesFound.length * 8;
    xrayScore -= weakWordsCount * 5;
    xrayScore -= longMessages * 6;
    xrayScore -= Object.keys(argumentKeywords).length * 4;
    xrayScore += openQuestionRatio * 20;
    xrayScore = Math.max(0, Math.min(100, Math.round(xrayScore)));

    return {
      xrayScore,
      vicesFound,
      vicesCount: vicesFound.length,
      weakWordsFound: [...new Set(weakWordsFound)],
      weakWordsCount,
      openQuestions,
      closedQuestions,
      openQuestionRatio: Math.round(openQuestionRatio * 100) / 100,
      avgMessageLength: Math.round(avgLength),
      longMessages,
      repeatedArgs: Object.keys(argumentKeywords),
    };
  }

  // ── Analyze trigger usage (local, regex-based) ──
  function analyzeTriggers(userMessages) {
    const fullText = userMessages.map(m => m.content || '').join(' ').toLowerCase();

    const triggerPatterns = {
      autoridade: [/especialista|lider|referência|reconhecido|certific|premiado|fundador|diretor|\d+ anos de/g],
      provaSocial: [/clientes?|empresa|caso de sucesso|testemunho|depoimento|parceiro|implementou|usa|utiliza|adota/g],
      urgencia: [/agora|hoje|essa semana|prazo|última|por tempo limitado|deadline|urgente|não pode esperar/g],
      especificidade: [/\d+%|R\$\s*\d|em \d+ (dias|semanas|meses)|exatamente|\d+ (clientes|empresas|casos)/g],
      empatia: [/entendo|compreendo|imagino|faz sentido|sua situação|sua dificuldade|você mencionou|eu ouço/g],
      clareza: [/simplificando|em poucas palavras|basicamente|para resumir|em resumo|o que isso significa|traduzindo/g],
      seguranca: [/garantia|sem risco|trial|gratuito|suporte|contrato|sla|reembolso|cancelar quando/g],
      controleExcessivo: [/precisa|tem que|deve|necessariamente|obrigator|não tem como não|é essencial que/g],
    };

    const result = {};
    Object.entries(triggerPatterns).forEach(([key, patterns]) => {
      let count = 0;
      patterns.forEach(pattern => {
        const matches = fullText.match(pattern);
        if (matches) count += matches.length;
      });
      result[key] = Math.min(5, count);
    });

    return result;
  }

  // ── Build final result object ──
  function buildResult(aiEvaluation, config, session) {
    const weights = config.weights || {};
    const scores = aiEvaluation?.scores || {
      rapport: 50, discovery: 50, value: 50,
      objections: 50, closing: 50, professionalism: 50
    };

    const total = calculateTotal(scores, weights);
    const convinced = aiEvaluation?.customerConvinced ?? (total >= 60);
    const badge = getBadge(total, convinced);
    const tips = generateTips(scores);
    const stats = formatSessionStats(session);

    // Build Raio-X from session messages
    const userMessages = (session.messages || []).filter(m => m.role === 'user');
    const styleXray = buildStyleXray(userMessages);

    // Trigger usage (combine AI + local analysis)
    const localTriggers = analyzeTriggers(userMessages);
    const aiTriggers = aiEvaluation?.triggerUsage || {};
    const triggerUsage = {};
    ['autoridade','provaSocial','urgencia','especificidade','empatia','clareza','seguranca','controleExcessivo'].forEach(key => {
      triggerUsage[key] = Math.max(localTriggers[key] || 0, aiTriggers[key] || 0);
    });

    return {
      total,
      scores,
      convinced,
      badge,
      tips,
      stats,
      scoreColor: getScoreColor(total),
      positives: aiEvaluation?.positives || [],
      improvements: aiEvaluation?.improvements || [],
      highlights: aiEvaluation?.highlightMoments || [],
      summary: aiEvaluation?.summary || '',
      narrative: aiEvaluation?.narrative || '',
      convictionFinal: aiEvaluation?.convictionFinal || 0,
      hiddenAgendaRevealed: aiEvaluation?.hiddenAgendaRevealed || false,
      languageVices: aiEvaluation?.languageVices || [],
      weakPoints: aiEvaluation?.weakPoints || [],
      styleXray,
      triggerUsage,
      config,
      session,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    calculateTotal,
    getBadge,
    getScoreColor,
    getCriteriaLabel,
    formatSessionStats,
    generateTips,
    buildStyleXray,
    analyzeTriggers,
    buildResult,
  };
})();
