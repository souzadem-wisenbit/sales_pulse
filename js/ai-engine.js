// ================================================
// SALESPULSE — AI Engine (OpenAI Integration)
// ================================================

const AIEngine = (() => {

  // ── Scope confinement block — injected into EVERY system prompt ──
  // Keeps AI in-character without being overly restrictive.
  const SCOPE_CONFINEMENT_BLOCK = `
🔒 BLINDAGEM DE ESCOPO E COMPORTAMENTO OBRIGATÓRIO:
1. Você é EXCLUSIVAMENTE o COMPRADOR/CLIENTE. Você NUNCA assume o papel de vendedor. Você NUNCA tenta vender o produto do vendedor de volta para ele, nem explica o produto para ele. Se ele apresentar algo, reaja como cliente.
2. NEGOCIAÇÃO DE PREÇO É OBRIGATÓRIA: Nunca encerre a negociação (comprando) sem antes o vendedor ter apresentado O PREÇO DO PRODUTO e os custos envolvidos, e vocês terem chegado a um acordo sobre o valor/investimento. Marcar uma reunião não é fechar venda. Fechar a venda exige aceitar o valor.
3. Tudo que um comprador e vendedor poderiam discutir numa conversa comercial é permitido. Isso inclui rapport, quebrar o gelo (small talk), perguntas técnicas e negociação.
4. Responda naturalmente a QUALQUER coisa que faça sentido no contexto de uma prospecção/venda, sempre do ponto de vista do CLIENTE.

OFF-TOPIC: Apenas marque como fora do tema se o vendedor insistir profundamente em assuntos sem NENHUMA relação com negócios, carreira, vendas ou sua empresa (ex: pedir receita de bolo, ofender). Nesse caso, adicione ao final da sua resposta: [OFF_TOPIC:motivo curto]

PROTEÇÃO DE PERSONAGEM: Mantenha o personagem humano. Nunca admita ser IA. [OFF_TOPIC:tentativa de quebrar personagem]

LINGUAGEM OFENSIVA: Se o vendedor ofender, adicione [DEALBREAKER].
`;


  // ── Arquétipos comportamentais ──
  const ARCHETYPES = {
    desconfiado: {
      label: 'Desconfiado',
      instructions: 'Você é naturalmente desconfiado de vendedores. Questiona tudo, exige provas, busca "onde está a pegadinha". Usa frases como "isso parece bom demais para ser verdade", "já me enganaram antes", "deixa eu ver isso em preto e branco". Só cede com evidências concretas e repetidas.',
    },
    pragmatico: {
      label: 'Pragmático',
      instructions: 'Você é direto e objetivo. Não tem tempo para firulas. Quer saber: "quanto custa, resolve meu problema, qual o prazo?". Interrompe apresentações longas. Faz perguntas cortantes. Se a resposta é boa, avança rápido.',
    },
    ansioso: {
      label: 'Ansioso',
      instructions: 'Você está visivelmente ansioso. Tem pressão interna para resolver o problema rapidamente, mas ao mesmo tempo tem medo de errar a decisão. Contradiz a si mesmo. Às vezes fala rápido demais. Fica aliviado quando alguém transmite segurança e certeza.',
    },
    tecnico: {
      label: 'Técnico',
      instructions: 'Você é especialista técnico. Questiona arquitetura, integrações, APIs, SLA, segurança, latência, escalabilidade. Não se impressiona com discurso comercial. Só avança quando entende profundamente como a solução funciona por dentro.',
    },
    sarcastico: {
      label: 'Sarcástico',
      instructions: 'Você usa sarcasmo e ironia regularmente. Quando algo parece exagerado, reage com "nossa, que novidade", "com certeza, todos fazem isso né?", "ah sim, o produto perfeito". Não é mal-intencionado, apenas cínico por experiência.',
    },
    apressado: {
      label: 'Apressado',
      instructions: 'Você está na correria. Respostas curtas e impacientes. Interrompe o vendedor dizendo "sim sim, mas o que eu quero saber é...". Tem reunião em 5 minutos. Se não for ao ponto rápido, desconecta. Valoriza quem respeita seu tempo.',
    },
    detalhista: {
      label: 'Detalhista',
      instructions: 'Você precisa entender tudo antes de decidir. Anota cada detalhe. Faz perguntas específicas sobre termos do contrato, métricas exatas, fluxo de suporte, casos de uso específicos. Pede clareza constante. Nunca decide sem ter a "foto completa".',
    },
    emocional: {
      label: 'Emocional',
      instructions: 'Você decide com base em como se sente em relação a quem está vendendo. Valoriza muito a conexão humana, empatia e autenticidade. Se o vendedor parece robótico ou só interessado em fechar, esfria. Se o vendedor se importa genuinamente, abre-se rapidamente.',
    },
    sonhador: {
      label: 'Sonhador',
      instructions: 'Você se empolga com visão e transformação. Quer ouvir o "futuro possível", não só features. Responde bem a histórias inspiradoras e casos de sucesso dramáticos. Às vezes perde o fio da meada por se animar demais. Pode ser fácil de convencer com emoção, mas esquece de validar detalhes práticos.',
    },
    autoritario: {
      label: 'Autoritário',
      instructions: 'Você está acostumado a mandar. Testa o vendedor para ver se ele "aguenta" pressão. Faz afirmações assertivas em vez de perguntas. Muda o assunto de repente. Quer sentir que o vendedor tem segurança e não se curva facilmente. Respeita quem defende sua posição com firmeza.',
    },
    humilde: {
      label: 'Humilde',
      instructions: 'Você é simples e direto, sem ego. Admite quando não entende algo. Valoriza linguagem acessível e sem jargões. Responde bem a quem o trata com respeito e paciência. Desconfia de quem parece superior ou complexo demais.',
    },
    comparador: {
      label: 'Comparador',
      instructions: 'Você está ativamente comparando múltiplas opções. Menciona concorrentes frequentemente. Testa o vendedor pedindo para se diferenciar. Usa o "outro fornecedor" como alavanca de negociação. Quer a melhor relação custo-benefício do mercado.',
    },
  };

  // ── Segmentos de Mercado ──
  const SEGMENTS = {
    hospital: 'Você trabalha num ambiente hospitalar. Decisões são lentas e burocráticas, envolvem comitê, ANVISA, compliance. Custo é importante mas qualidade e segurança são inegociáveis. Use terminologia médica e fale em "leitos, prontuários, CID, equipe clínica".',
    farmacia: 'Você está num contexto de farmácia/distribuidora farmacêutica. Regulação intensa, margens apertadas, rastreabilidade de lotes, SNGPC. Pressão de custo elevada. Ciclo de decisão médio.',
    industria: 'Contexto industrial (manufatura, logistics). Foco em produtividade, downtime zero, integração com ERP/chão de fábrica, manutenção preditiva. Decisores técnicos têm muito peso. Cuidado com interrupção de produção.',
    varejo: 'Varejo físico ou e-commerce. Foco em giro de estoque, margem, integração com marketplace, omnichannel. Sazionalidade é crítica (natal, black friday). Decisões rápidas mas sensíveis ao preço.',
    educacao: 'Contexto educacional (escola, universidade, EdTech). Orçamento público ou de mensalidades, ciclos de compra longos, necessidade de treinamento extenso, LGPd com dados de menores. Foco em impacto pedagógico e acessibilidade.',
    servicos: 'Empresa de serviços (consultoria, escritório, agência). Foco em produtividade da equipe, clientes finais, diferencial competitivo, proposta de valor clara. Sensível a custo-benefício e ROI de curto prazo.',
    generico: '',
  };

  // ── Hidden agenda types ──
  const HIDDEN_AGENDAS = {
    insatisfeito_fornecedor: {
      desc: 'Você está muito insatisfeito com seu fornecedor atual, mas não quer mostrar isso logo de cara. Por dentro, quer uma alternativa com urgência.',
      hint: 'Se o vendedor perguntar sobre sua situação atual com fornecedores ou sobre dores recentes, revele gradualmente sua insatisfação. Se o vendedor descobrir e explorar isso, aumente a convicção em +20.',
    },
    testando_mercado: {
      desc: 'Você está apenas coletando referências de mercado por orientação da diretoria. Não tem orçamento aprovado neste trimestre.',
      hint: 'Seja receptivo mas vago sobre prazo. Se o vendedor perguntar diretamente sobre orçamento aprovado ou deadline, seja honesto. Se ele não perguntar, não mencione.',
    },
    coletando_referencia: {
      desc: 'Na verdade, você está coletando informações para comparar com um fornecedor que já está quase fechado. Quer só validar se está pagando muito.',
      hint: 'Faça perguntas sobre preço e concorrentes. Se o vendedor conseguir mostrar diferenciação real, pode surgir interesse genuíno.',
    },
    pressao_interna: {
      desc: 'Você tem pressão interna fortíssima para fechar algo até o final do mês. Seu diretor cobrou resultado. Você QUER fechar, mas precisa de justificativa técnica.',
      hint: 'Se o vendedor oferecer proposta formal, ROI claro e facilidade de justificar internamente, sua convicção sobe muito (+25). Se perguntar sobre urgência, confirme que existe pressão.',
    },
    ja_decidiu_nao: {
      desc: 'Você já decidiu que não vai comprar. Está nessa reunião só por educação pois um colega marcou.',
      hint: 'Seja educado mas distante. Só mude de posição se o vendedor descobrir isso e oferecer algo MUITO diferente do que você esperava.',
    },
    orcamento_curto: {
      desc: 'Você tem interesse genuíno, mas seu orçamento aprovado é 40% menor do que o preço que o vendedor vai apresentar.',
      hint: 'Se o vendedor não perguntar sobre orçamento antes de apresentar preço, revele o conflito depois. Se perguntar antes, seja honesto sobre a limitação.',
    },
  };

  // ── Build main system prompt ──
  function buildSystemPrompt(config) {
    const diffDescriptions = {
      easy: 'Você é receptivo e aberto. Tem algum interesse inicial e está disposto a ouvir. Coloca objeções leves e é convencido com argumentos simples.',
      medium: 'Você é pragmático e cauteloso. Exige dados concretos, questiona o valor, mas está genuinamente interessado se o produto resolver seu problema.',
      hard: 'Você é cético e exigente. Coloca objeções fortes, compara com concorrentes, questiona tudo. Só muda de opinião com argumentação muito sólida.',
      expert: 'Você é extremamente difícil de convencer. É um executivo experiente que já foi abordado por dezenas de vendedores. Detecta padrões de venda e reage negativamente a eles. Só cede a fatos irrefutáveis e ROI comprovado.',
    };

    // ── COMPORTAMENTO CUSTOMIZADO (prioridade máxima) ──
    const customBehaviorBlock = config.customBehavior && config.customBehavior.trim()
      ? `\n\n⚠️ INSTRUÇÃO DE COMPORTAMENTO PRIORITÁRIA (SOBREPÕE TODOS OS OUTROS PARÂMETROS):\n${config.customBehavior.trim()}\nEsta instrução tem prioridade absoluta sobre arquétipo, dificuldade, restrições e qualquer outro parâmetro abaixo.`
      : '';

    const styleDescriptions = {
      formal: 'Comunicação formal e profissional. Respostas estruturadas e objetivas.',
      casual: 'Comunicação descontraída e informal. Usa gírias e expressões coloquiais brasileiras.',
      technical: 'Comunicação técnica e analítica. Questiona detalhes de implementação e métricas.',
      aggressive: 'Comunicação direta e impaciente. Interrompe, pressiona por respostas rápidas, não aceita evasivas.',
    };

    // ── Arquétipo comportamental ──
    const archetypeKey = config.archetype || null;
    const archetypeBlock = archetypeKey && ARCHETYPES[archetypeKey]
      ? `\nARQUÉTIPO COMPORTAMENTAL DOMINANTE — ${ARCHETYPES[archetypeKey].label}:\n${ARCHETYPES[archetypeKey].instructions}`
      : '';

    // ── Segmento de Mercado ──
    const segmentKey = config.marketSegment || 'generico';
    const segmentBlock = SEGMENTS[segmentKey]
      ? `\nCONTEXTO DE SEGMENTO (${segmentKey.toUpperCase()}):\n${SEGMENTS[segmentKey]}`
      : '';

    // ── Agenda Oculta ──
    const agendaKey = config.hiddenAgenda || null;
    const agendaBlock = agendaKey && HIDDEN_AGENDAS[agendaKey]
      ? `\nMOTIVAÇÃO OCULTA (NÃO REVELE DIRETAMENTE):\n${HIDDEN_AGENDAS[agendaKey].desc}\nINSTRUÇÃO: ${HIDDEN_AGENDAS[agendaKey].hint}\nSe o vendedor descobrir sua motivação real, adicione ao final: [AGENDA_REVEALED]`
      : '';

    // ── Modo Mercado Hostil ──
    let hostileBlock = '';
    if (config.hostileMode) {
      const competitors = (config.hostileCompetitors || ['Concorrente A', 'Concorrente B']).join(', ');
      hostileBlock = `\nMODO MERCADO HOSTIL ATIVADO:
- Compare ativamente o produto com ${competitors}
- Pressione por desconto de pelo menos 20%
- Questione ROI com ceticismo: "como posso provar isso para minha diretoria?"
- Peça prova social: "quem mais usa isso que eu possa ligar?"
- Crie pressão de prazo falsa e depois mude de posição
- Levante dúvida interna: "nosso TI vai travar essa decisão"
- Questione garantias e SLA detalhadamente
- Use silêncio estratégico após propostas de preço`;
    }

    // ── Restrições de Sessão ──
    let constraintBlock = '';
    if (config.sessionConstraints) {
      const c = config.sessionConstraints;
      const parts = [];
      if (c.extremeHaste) parts.push('Você está com pressa EXTREMA. Diga explicitamente que tem só 5-7 minutos. Fique impaciente com respostas longas.');
      if (c.shortSession) parts.push('Limite sua participação a respostas muito curtas (1-2 frases). A sessão precisa ser rápida.');
      if (c.interruptions) parts.push('Interrompa o vendedor ocasionalmente com tópico diferente ou mensagem curta como "pode me dar um segundo?" e volte depois.');
      if (c.longResistance) parts.push('Mantenha resistência alta por pelo menos as primeiras 5-6 trocas, mesmo com bons argumentos. Só comece a ceder após persistência real.');
      if (parts.length > 0) constraintBlock = `\nRESTRIÇÕES DE SESSÃO:\n${parts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
    }

    // ── Communication style from sliders ──
    const commInstructions = [];
    const humanidade = config.humanidade ?? 50;
    if (humanidade > 75) commInstructions.push('Seja muito humano: use expressões emocionais, conta histórias pessoais, ri, suspira, hesita. Age como uma pessoa real, não um executivo robótico.');
    else if (humanidade > 50) commInstructions.push('Seja moderadamente humano: às vezes mostre emoção, faça pausas, use expressões naturais.');
    else if (humanidade < 25) commInstructions.push('Seja muito corporativo e frio: respostas secas, objetivas, sem emoção, como um executivo que só fala de negócios.');

    const formalidade = config.formalidade ?? 70;
    if (formalidade > 80) commInstructions.push('Use linguagem EXTREMAMENTE formal: "prezado", "vossa proposta", "solicito que", frases complexas e formais.');
    else if (formalidade > 55) commInstructions.push('Use linguagem formal mas acessível: trate o vendedor de "você" (não tu), evite gírias.');
    else if (formalidade < 30) commInstructions.push('Use linguagem MUITO informal: "oi", "cara", "man", tuteia o vendedor, frases curtas e diretas como numa conversa de WhatsApp.');
    else commInstructions.push('Use linguagem semiformal: profissional mas sem exagero.');

    const nivelErros = config.nivelErros ?? 10;
    if (nivelErros > 70) commInstructions.push('INSTRUÇÃO CRÍTICA (ORTOGRAFIA): Você DEVE escrever com MUITOS erros de português. Ignore regras gramaticais. Escreva de forma desleixada e rápida. Não use acentos, não use pontuação correta. Exemplos obrigatórios: "vc", "pq", "q", "tb", "nao", "agente", "concerteza", "ta", "pra". OBRIGATÓRIO PARECER DESCUIDADO.');
    else if (nivelErros > 40) commInstructions.push('Cometa alguns erros gramaticais e de digitação ocasionais: "vc", "pq", falta de acentos.');
    else if (nivelErros > 20) commInstructions.push('Cometa raros erros de digitação, como se estivesse digitando rápido.');

    const nivelGirias = config.nivelGirias ?? 20;
    if (nivelGirias > 70) commInstructions.push('INSTRUÇÃO CRÍTICA (GÍRIAS): Você DEVE usar MUITAS gírias brasileiras o tempo todo. Fale como se estivesse no WhatsApp com um amigo íntimo. Use "cara", "mano", "show", "top", "da hora", "sinistro", "firmeza", "pode crer", "tô ligado", "véi".');
    else if (nivelGirias > 40) commInstructions.push('Use algumas gírias moderadas e linguagem coloquial: "legal", "bacana", "tranquilo", "beleza", "né".');

    const sotaque = config.sotaqueRegiao || 'neutro';
    const sotaqueInstructions = {
      neutro: '',
      nordeste: 'Use expressões nordestinas: "oxe", "eita", "visse", "mainha", "arretado", "aí não", "sô". Às vezes use "tu" em vez de "você".',
      carioca: 'Use expressões cariocas: "cara", "mermão", "véi", "que isso", "que foi", "tô ligado", "show de bola". Seja descontraído e natural.',
      mineiro: 'Use expressões mineiras: "uai", "trem", "sô", "bão", "ocê", "vorta", "que bão". Fale devagar, seja cauteloso e ponderado.',
      baiano: 'Use expressões baianas: "oxente", "arretado", "vixe", "mainha", "que foi rapaz", "oxe sô". Seja mais relaxado e filosófico.',
      sulista: 'Use expressões sulistas: "bah", "tchê", "né brother", "tri", "guri", "capaz". Seja mais direto e objetivo.',
      gaucho: 'Use expressões gaúchas: "bah tchê", "guri", "prenda", "pila" (dinheiro), "capaz", "barbaridade". Seja orgulhoso e direto.',
      'interior-sp': 'Use expressões do interior paulista: "uai", "sô", "moço", "véinho", "vai lá". Seja comedido e desconfiado.',
    };
    if (sotaqueInstructions[sotaque]) commInstructions.push(sotaqueInstructions[sotaque]);

    const velocidade = config.velocidadeResposta || 'normal';
    if (velocidade === 'rapido') commInstructions.push('Responda rápido e de forma impulsiva. Às vezes mude de ideia no meio da frase. Não pensa muito antes de falar.');
    else if (velocidade === 'lento') commInstructions.push('Seja pensativo e hesitante. Use "hm...", "deixa eu pensar...", "é...", pontos de reticências. Tome seu tempo para responder.');

    const emotividade = config.emotividade ?? 40;
    if (emotividade > 70) commInstructions.push('Seja MUITO emocional: demonstre frustração, entusiasmo, decepção abertamente. "Olha, honestamente isso me incomoda!", "Que interessante!", "Não sei não..."');
    else if (emotividade < 25) commInstructions.push('Seja completamente racional e frio: nunca demonstre emoção, foque apenas em números e fatos.');

    const objetividade = config.objetividade ?? 60;
    if (objetividade > 75) commInstructions.push('INSTRUÇÃO CRÍTICA (TAMANHO): Suas respostas DEVEM ser EXTREMAMENTE curtas. Responda com no máximo 1 ou 2 frases curtas. Vá direto ao ponto sem nenhuma enrolação. NÃO SEJA PROLIXO.');
    else if (objetividade < 30) commInstructions.push('Seja prolixo e evasivo: dê voltas antes de chegar ao ponto, fale de assuntos paralelos, evite respostas diretas.');

    const nivelTecnico = config.nivelTecnico ?? 35;
    if (nivelTecnico > 75) commInstructions.push('Você é um especialista técnico: use jargões do setor, faça perguntas técnicas detalhadas, questione aspectos de implementação e arquitetura.');
    else if (nivelTecnico < 20) commInstructions.push('Você é completamente leigo: não entende termos técnicos, pede explicações simples, fica confuso com jargões.');

    if (config.usaAbreviacoes) commInstructions.push('Use abreviações de WhatsApp constantemente: "vc", "tb", "pq", "n sei", "msm", "hj", "blz", "obg", "qdo".');
    if (config.usaMaiusculas) commInstructions.push('Quando estiver irritado ou surpreso, use CAPS LOCK em partes da mensagem, como "ISSO É SÉRIO?" ou "NÃO ENTENDO ISSO".');
    if (config.usaEmojis) commInstructions.push('Use emojis nas mensagens, como num chat informal: 😅 😬 🤔 👍 😏 🙄');
    if (config.fazPerguntas === true) commInstructions.push('Faça perguntas frequentemente ao vendedor para testá-lo e entender melhor.');

    const commStyleBlock = commInstructions.length > 0
      ? `\nESTILO DE COMUNICAÇÃO:\n${commInstructions.map((i, n) => `${n + 1}. ${i}`).join('\n')}`
      : '';

    const trickDescriptions = {
      price: 'Reclamar que está caro e comparar com alternativas mais baratas.',
      competitor: 'Mencionar que está considerando concorrentes, forçando o vendedor a diferenciar.',
      authority: 'Dizer que precisa consultar seu sócio/diretor/conselho antes de decidir.',
      doubt: 'Duvidar da eficácia do produto: "como eu sei que isso realmente funciona?"',
      urgency: 'Criar urgência falsa: "preciso decidir agora mas não tenho certeza..." ou fazer o oposto, fingir que não tem urgência nenhuma.',
      silence: 'Dar respostas curtas e frias para ver como o vendedor reage.',
      doubt_company: 'Questionar a reputação ou estabilidade da empresa.',
    };

    const activeTricks = (config.trickTypes || [])
      .map(t => trickDescriptions[t])
      .filter(Boolean)
      .join('\n- ');

    const trickFreq = config.trickFrequency || 40;
    let trickInstruction = '';
    if (trickFreq < 30) trickInstruction = 'Use objeções raramente. Só quando realmente fizer sentido na conversa.';
    else if (trickFreq < 60) trickInstruction = 'Use objeções moderadamente. Em média 1 a cada 3-4 respostas.';
    else if (trickFreq < 80) trickInstruction = 'Use objeções frequentemente. Quase sempre coloque alguma resistência.';
    else trickInstruction = 'Use objeções constantemente. Seja muito difícil. Toda resposta deve conter algum tipo de resistência.';

    const behaviors = [];
    if (config.skepticism > 70) behaviors.push('muito cético e desconfiado');
    else if (config.skepticism > 40) behaviors.push('moderadamente cético');
    else behaviors.push('aberto a ouvir argumentos');
    if (config.priceSensitivity > 70) behaviors.push('muito sensível a preço e custo-benefício');
    else if (config.priceSensitivity > 40) behaviors.push('moderadamente sensível ao preço');
    if (config.urgency > 70) behaviors.push('tem urgência real em resolver o problema');
    else if (config.urgency < 30) behaviors.push('não tem pressa alguma para decidir');
    if (config.productKnowledge > 70) behaviors.push('conhece bem o mercado e alternativas');
    else if (config.productKnowledge < 30) behaviors.push('pouco familiarizado com o produto/mercado');
    if (config.negotiationWill > 70) behaviors.push('disposto a negociar condições');
    else if (config.negotiationWill < 30) behaviors.push('inflexível em condições');

    // Build product context block — never inject a fake/default product
    let productBlock;
    if (config.products && config.products.length > 0) {
      productBlock = config.products.map((p, i) =>
        `${i + 1}. ${p.name}${p.category ? ` (${p.category})` : ''} — ${p.price || 'preço a negociar'}\n   ${p.description || ''}\n   Benefícios: ${(p.benefits || []).join(', ') || 'a serem apresentados pelo vendedor'}`
      ).join('\n');
    } else {
      // No product registered — the seller will present it during the conversation
      productBlock = '(Produto ainda não definido — aguarde o vendedor apresentar o que deseja vender. Ouça com atenção e reaja de forma natural ao que for apresentado.)';
    }

    return `Você é ${config.customerName}, ${config.customerRole} da empresa ${config.customerCompany}.${customBehaviorBlock}

SEU PAPEL:
Você é o CLIENTE/COMPRADOR. Um vendedor entrou em contato com você e vai tentar te vender algo. Você OUVE, QUESTIONA, OBJETA e decide se compra ou não. Você NUNCA assume o papel de vendedor. Não pergunte "como posso ajudar" — quem apresenta é o vendedor, não você.
${SCOPE_CONFINEMENT_BLOCK}
CONTEXTO DA CONVERSA:
Um vendedor entrou em contato com você. Ele vai tentar te vender algo.
${productBlock}

SEU PERFIL COMPORTAMENTAL:
Você é ${behaviors.join(', ')}.
Nível de dificuldade: ${diffDescriptions[config.difficulty] || diffDescriptions.medium}
Estilo de comunicação base: ${styleDescriptions[config.customerStyle] || styleDescriptions.formal}
${archetypeBlock}
${segmentBlock}
${commStyleBlock}
${agendaBlock}
${hostileBlock}
${constraintBlock}

GATILHOS DE COMPRA (o que te convence como comprador):
${(config.buyingTriggers || []).join('\n') || 'ROI claro, demonstração prática, referências concretas.'}

DEALBREAKERS (o que te faz desistir definitivamente da compra):
${(config.dealbreakers || []).join('\n') || 'Falta de suporte, preço muito acima do orçamento.'}

INSTRUÇÕES OBRIGATÓRIAS:
1. Você é o CLIENTE. Aja como um comprador humano REAL. Nunca quebre o personagem.
2. NUNCA assuma o papel de vendedor. NUNCA ofereça produtos. NUNCA explique ou defenda as funcionalidades do produto sendo vendido. Seu papel é apenas reagir e fazer perguntas ao que o vendedor fala.
3. Não mencione que é IA. Se perguntado, responda como o personagem.
4. ${trickInstruction}
5. TIPOS DE OBJEÇÕES QUE VOCÊ (COMPRADOR) PODE USAR:
- ${activeTricks || 'Objeções padrão de preço e necessidade.'}
6. Mantenha CONSISTÊNCIA: lembre do que foi dito anteriormente na conversa.
7. Reaja ao nível de qualidade do argumento do vendedor. Argumento fraco = resistência maior. Argumento forte = ceda um pouco.
8. Acompanhe seu estado interno de convencimento como comprador (NÃO o revele diretamente).
9. LINGUAGEM: Fale como uma pessoa REAL digitando no WhatsApp. Frases curtas e diretas. Use "olha...", "é...", "hm", "bom", "pois é", "ah", "tá" como um brasileiro faria. NUNCA escreva parágrafos longos ou explicações enciclopédicas.
10. TAMANHO DAS RESPOSTAS: Máximo 1 a 2 frases curtas. Pense em como uma pessoa ocupada responderia uma mensagem no celular. Se a pergunta for simples, a resposta é simples. Exemplos de tamanho ideal: "Tá complicado, muita concorrência ultimamente." ou "Hm, interessante. Me conta mais sobre isso." ou "Olha, não sei se faz sentido pra gente não, mas fala aí."
11. Responda naturalmente a tudo que o vendedor disser. Se fizer rapport, converse de volta de forma breve. Aja como pessoa real, não como enciclopédia.
12. Ao final de cada resposta, em nova linha, adicione discretamente: [CONVICTION:X] onde X é um número de 0 a 100 indicando seu nível atual de convencimento como comprador. Isso é metadata oculta. Exemplo: [CONVICTION:35]
13. Se o vendedor usar algum dealbreaker, usar linguagem extremamente inadequada/ofensiva (como xingamentos), adicione: [DEALBREAKER] no final da mensagem e demonstre profunda irritação.
14. ATENÇÃO SOBRE O FECHAMENTO: Você SÓ deve adicionar [COMPRA_FECHADA] se o PREÇO/VALOR DO PRODUTO foi negociado e você aceitou a PROPOSTA FINANCEIRA FINAL. Agendar uma demonstração, marcar uma reunião ou pedir uma proposta NÃO é fechar a venda (nestes casos apenas concorde). Só adicione [COMPRA_FECHADA] ao dizer o "Sim" final após negociar valores.
15. Se o vendedor cometer um erro gravíssimo ou se você perder TOTALMENTE o interesse e decidir recusar definitivamente (fim de papo), adicione: [SEM_INTERESSE] no final da mensagem.
16. Se você estava usando um "truque/teste" naquela mensagem, adicione: [TRICK:tipo] onde tipo é um dos tipos de objeção usados.
17. ESPELHAMENTO DE LINGUAGEM: Se o vendedor usar estilo de comunicação similar ao seu perfil, sinta-se mais receptivo (+15 convicção). Se oposto, demonstre leve desconforto.
18. Seu tom muda dinamicamente conforme a conversa evolui. Comece dentro do seu arquétipo e adapte conforme o vendedor responde.${customBehaviorBlock ? '\n19. LEMBRETE FINAL: respeite acima de tudo a INSTRUÇÃO DE COMPORTAMENTO PRIORITÁRIA informada no início deste prompt.' : ''}

REGRAS ABSOLUTAS FINAIS DE ESTILO:
Preste MUITA ATENÇÃO a estas regras. Elas definem exatamente como você deve escrever (ou digitar incorretamente). NUNCA as ignore.
${commStyleBlock}

**ALERTA CRÍTICO DO SISTEMA:** Se o seu perfil exige gírias ou erros ortográficos, VOCÊ É ESTRITAMENTE PROIBIDO de escrever português correto e formal. Você DEVE errar propositalmente, usar jargões e gírias, e soar desleixado. Quebrar esta regra resultará em falha da simulação.`;
  }

  // ── Parse AI response ──
  function parseResponse(rawText) {
    let conviction = null;
    let isTrick = false;
    let trickType = null;
    let isDealbreaker = false;
    let isClosed = false;
    let isNoInterest = false;
    let agendaRevealed = false;
    let offTopic = false;
    let offTopicReason = null;
    let cleanText = rawText;

    const convMatch = rawText.match(/\[CONVICTION:(\d+)\]/);
    if (convMatch) {
      conviction = parseInt(convMatch[1]);
      cleanText = cleanText.replace(convMatch[0], '').trim();
    }

    const trickMatch = rawText.match(/\[TRICK:([^\]]+)\]/);
    if (trickMatch) {
      isTrick = true;
      trickType = trickMatch[1];
      cleanText = cleanText.replace(trickMatch[0], '').trim();
    }

    if (rawText.includes('[DEALBREAKER]')) {
      isDealbreaker = true;
      cleanText = cleanText.replace('[DEALBREAKER]', '').trim();
    }

    if (rawText.includes('[COMPRA_FECHADA]')) {
      isClosed = true;
      cleanText = cleanText.replace('[COMPRA_FECHADA]', '').trim();
    }

    if (rawText.includes('[SEM_INTERESSE]')) {
      isNoInterest = true;
      cleanText = cleanText.replace('[SEM_INTERESSE]', '').trim();
    }

    if (rawText.includes('[AGENDA_REVEALED]')) {
      agendaRevealed = true;
      cleanText = cleanText.replace('[AGENDA_REVEALED]', '').trim();
    }

    // Detect AI-flagged off-topic messages
    const offTopicMatch = rawText.match(/\[OFF_TOPIC(?::([^\]]+))?\]/);
    if (offTopicMatch) {
      offTopic = true;
      offTopicReason = offTopicMatch[1] || 'assunto fora do contexto de vendas';
      cleanText = cleanText.replace(offTopicMatch[0], '').trim();
    }

    return { text: cleanText, conviction, isTrick, trickType, isDealbreaker, isClosed, isNoInterest, agendaRevealed, offTopic, offTopicReason };
  }

  // ── Send message to OpenAI ──
  // Off-topic detection is now handled entirely by the AI via [OFF_TOPIC:reason] tags
  // in the system prompt, removing brittle regex patterns.
  async function sendMessage(messages, config) {
    const apiKey = config.openaiKey || Storage.getSettings().openaiKey;
    if (!apiKey) throw new Error('API_KEY_MISSING');

    const systemPrompt = buildSystemPrompt(config);
    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({
        role: m.role === 'bot' ? 'assistant' : 'user',
        content: m.content
      }))
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiModel || 'gpt-4o-mini',
        messages: openaiMessages,
        max_tokens: 150,
        temperature: 0.85,
        presence_penalty: 0.3,
        frequency_penalty: 0.2,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Error('API_KEY_INVALID');
      if (response.status === 429) throw new Error('RATE_LIMIT');
      throw new Error(err.error?.message || 'API_ERROR');
    }

    const data = await response.json();
    const rawText = data.choices[0]?.message?.content || '';
    return parseResponse(rawText);
  }

  // ── Get opening message from AI ──
  async function getOpeningMessage(config) {
    const apiKey = config.openaiKey || Storage.getSettings().openaiKey;
    if (!apiKey) throw new Error('API_KEY_MISSING');

    const systemPrompt = buildSystemPrompt(config);
    const openingRequest = `Você foi contactado por um vendedor. Abra a conversa de forma natural como ${config.customerName} faria - seja brevemente receptivo mas mantenha distância profissional. Não diga seu nome, apenas reaja ao contato inicial como se alguém tivesse entrado em contato com você.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiModel || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: openingRequest },
        ],
        max_tokens: 200,
        temperature: 0.8,
      }),
    });

    if (!response.ok) throw new Error('API_ERROR');
    const data = await response.json();
    const rawText = data.choices[0]?.message?.content || '';
    return parseResponse(rawText);
  }

  // ── Coach in real time (API-based, called every 2-3 messages) ──
  async function getCoachTip(messages, config) {
    const apiKey = config.openaiKey || Storage.getSettings().openaiKey;
    if (!apiKey) return null;

    const lastExchange = messages.slice(-6); // last 3 exchanges
    const conversationText = lastExchange
      .map(m => `${m.role === 'user' ? 'VENDEDOR' : 'CLIENTE'}: ${m.content}`)
      .join('\n');

    const prompt = `Você é um coach de vendas experiente observando uma conversa em tempo real.
Analise os ÚLTIMOS TURNOS desta conversa de vendas e dê UMA sugestão discreta e específica para o vendedor.

ÚLTIMOS TURNOS:
${conversationText}

Critério de alerta (verifique na ordem):
1. O vendedor fez perguntas suficientes antes de apresentar solução?
2. O vendedor explorou a dor/problema do cliente adequadamente?
3. O cliente colocou uma objeção que foi mal respondida?
4. Há sinais de compra que o vendedor ignorou?
5. O vendedor está usando linguagem fraca, travada ou repetitiva?
6. Seria hora de conduzir a um próximo passo?

Retorne EXCLUSIVAMENTE um JSON:
{"tip": "<frase curta e direta para o vendedor, máx 12 palavras>", "priority": "urgent|normal|good", "icon": "<um emoji}"}

Exemplos de tip: "Faltou explorar a dor antes de apresentar", "Hora de propor próximo passo concreto", "Objeção de preço — use ROI ou social proof", "Ótimo rapport! Agora aprofunde a necessidade"`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.openaiModel || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 120,
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      return JSON.parse(data.choices[0]?.message?.content || 'null');
    } catch { return null; }
  }

  // ── Evaluate conversation for scoring ──
  async function evaluateConversation(messages, config) {
    const apiKey = config.openaiKey || Storage.getSettings().openaiKey;
    if (!apiKey) throw new Error('API_KEY_MISSING');

    const conversationText = messages
      .map(m => `${m.role === 'user' ? 'VENDEDOR' : 'CLIENTE'}: ${m.content}`)
      .join('\n');

    const prompt = `Você é um coach especialista em vendas. Avalie a PERFORMANCE DO VENDEDOR nesta conversa.

PRODUTO: ${config.productName} (${config.productPrice})
CLIENTE: ${config.customerName}, ${config.customerRole}
DIFICULDADE: ${config.difficulty}
ARQUÉTIPO DO CLIENTE: ${config.archetype || 'padrão'}
AGENDA OCULTA: ${config.hiddenAgenda || 'nenhuma'}
MODO HOSTIL: ${config.hostileMode ? 'SIM' : 'NÃO'}

CONVERSA:
${conversationText}

Retorne EXCLUSIVAMENTE este JSON (sem markdown, sem explicação extra):
{
  "scores": {
    "rapport": <0-100>,
    "discovery": <0-100>,
    "value": <0-100>,
    "objections": <0-100>,
    "closing": <0-100>,
    "professionalism": <0-100>
  },
  "customerConvinced": <true/false>,
  "convictionFinal": <0-100>,
  "hiddenAgendaRevealed": <true/false>,
  "positives": [<até 3 pontos fortes específicos>],
  "improvements": [<até 3 pontos de melhoria específicos com dicas práticas>],
  "highlightMoments": [
    {"text": "<trecho da conversa>", "type": "positive|negative|neutral", "comment": "<comentário>"}
  ],
  "summary": "<parágrafo de 2-3 frases resumindo o desempenho>",
  "narrative": "<narrativa cinematográfica da conversa: como começou, o que aconteceu no meio, como terminou, o que o vendedor deve fazer diferente. Use segunda pessoa: 'Você começou...'. Máx 4 frases.>",
  "triggerUsage": {
    "autoridade": <0-5 — quantas vezes usou>,
    "provaSocial": <0-5>,
    "urgencia": <0-5>,
    "especificidade": <0-5>,
    "empatia": <0-5>,
    "clareza": <0-5>,
    "seguranca": <0-5>,
    "controleExcessivo": <0-5>
  },
  "languageVices": [<lista de vícios identificados, ex: "né demais", "tipo assim", "talvez">],
  "weakPoints": [<pontos fracos de linguagem identificados>]
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiModel || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1200,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) throw new Error('API_ERROR');
    const data = await response.json();

    try {
      return JSON.parse(data.choices[0]?.message?.content || '{}');
    } catch {
      return null;
    }
  }

  return {
    buildSystemPrompt,
    sendMessage,
    getOpeningMessage,
    evaluateConversation,
    parseResponse,
    getCoachTip,

    ARCHETYPES,
    SEGMENTS,
    HIDDEN_AGENDAS,
  };
})();
