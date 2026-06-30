// ================================================
// SALESPULSE — Results Page
// ================================================

const Results = (() => {

  let currentResult = null;

  function render(result, sessionId) {
    currentResult = result;
    // The page container is 'page-results' in index.html
    const page = document.getElementById('page-results');
    if (!page) { console.error('Results page element not found'); return; }
    page.innerHTML = '';

    const badge = result.badge;
    const score = result.total;
    const color = result.scoreColor;

    // SVG ring
    const radius = 80;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (score / 100) * circumference;

    page.innerHTML = `
      <div class="results-page">
        <div class="container container--narrow">

          <!-- Header -->
          <div class="results-header">
            <a href="#" onclick="App.navigate(Auth.isSeller()?'seller':'manager');return false"
               style="display:inline-flex;align-items:center;gap:8px;color:var(--text-muted);font-size:0.85rem;margin-bottom:var(--sp-6)">
              ← Voltar
            </a>
            <h2 class="gradient-text" style="font-size:1.6rem;margin-bottom:var(--sp-2)">Resultado da Sessão</h2>
            <p>${result.config?.productName} — ${result.config?.customerName}</p>
          </div>

          <!-- Score ring -->
          <div style="text-align:center;margin-bottom:var(--sp-8);animation:fadeInUp 0.6s var(--ease-out)">
            <div class="score-ring-container">
              <svg class="score-ring-svg" width="200" height="200" viewBox="0 0 200 200">
                <circle class="score-ring-bg" cx="100" cy="100" r="${radius}"/>
                <circle class="score-ring-fill"
                  cx="100" cy="100" r="${radius}"
                  stroke="${color}"
                  stroke-dasharray="${circumference}"
                  stroke-dashoffset="${circumference}"
                  id="score-ring-circle"
                  style="filter: drop-shadow(0 0 12px ${color}66)"
                />
              </svg>
              <div class="score-ring-text">
                <div class="score-big-num" id="score-number" style="color:${color}">0</div>
                <div class="score-label-text">pontos</div>
              </div>
            </div>

            <div class="result-badge-large ${badge.level}">
              <span style="font-size:2rem">${badge.emoji}</span>
              ${badge.label}
            </div>

            <div style="margin-top:var(--sp-4);display:flex;gap:var(--sp-4);justify-content:center;flex-wrap:wrap">
              <span class="badge ${result.convinced ? 'badge-success' : 'badge-danger'}" style="font-size:0.85rem;padding:6px 16px">
                ${result.convinced ? '✅ Cliente Convencido!' : '❌ Não Convenceu'}
              </span>
              <span class="badge badge-muted">⏱ ${result.stats.duration}</span>
              <span class="badge badge-muted">💬 ${result.stats.userMessages} msg enviadas</span>
              <span class="badge badge-warning">🃏 ${result.stats.trickCount} truques usados</span>
            </div>
          </div>

           <!-- New Badges -->
          ${(result.newBadges && result.newBadges.length > 0) ? BadgeSystem.renderNewBadgesPopup(result.newBadges) : ''}

          <!-- Narrative -->
          ${result.narrative ? `
            <div class="card mb-6" style="background:rgba(108,99,255,0.04);border-color:rgba(108,99,255,0.15)">
              <h4 style="margin-bottom:var(--sp-3);color:var(--accent-light)">🎥 Narrativa da Sessão</h4>
              <p style="line-height:1.85;font-size:0.95rem;color:var(--text-secondary)">${escHtml(result.narrative)}</p>
            </div>
          ` : result.summary ? `
            <div class="card mb-6" style="background:rgba(108,99,255,0.06);border-color:rgba(108,99,255,0.2)">
              <p style="line-height:1.8;font-size:0.95rem">${escHtml(result.summary)}</p>
            </div>
          ` : ''}

          <!-- Hidden Agenda Status -->
          ${result.config?.hiddenAgenda ? `
            <div class="card mb-6" style="background:${result.hiddenAgendaRevealed ? 'rgba(46,213,115,0.06)' : 'rgba(255,71,87,0.04)'};border-color:${result.hiddenAgendaRevealed ? 'rgba(46,213,115,0.2)' : 'rgba(255,71,87,0.2)'}">
              <div style="display:flex;align-items:center;gap:var(--sp-3)">
                <span style="font-size:1.8rem">${result.hiddenAgendaRevealed ? '🎉' : '🔒'}</span>
                <div>
                  <div style="font-weight:700;color:${result.hiddenAgendaRevealed ? 'var(--success)' : 'var(--danger)'}">${result.hiddenAgendaRevealed ? 'Agenda Oculta Descoberta!' : 'Agenda Oculta Não Descoberta'}</div>
                  <div class="text-muted fs-xs">${result.hiddenAgendaRevealed ? '+Bônus na avaliação por descobrir a motivação real do cliente.' : 'Você não descobriu a motivação oculta. Use mais perguntas de diagnóstico na próxima vez.'}</div>
                </div>
              </div>
            </div>
          ` : ''}

          <!-- Breakdown -->
          <div class="breakdown-card mb-6" style="animation:fadeInUp 0.6s var(--ease-out) 0.2s both">
            <h3 style="margin-bottom:var(--sp-5)">📊 Detalhamento por Critério</h3>
            ${Object.entries(result.scores).map(([key, score]) => {
              const info = ScoringEngine.getCriteriaLabel(key);
              const weight = result.config?.weights?.[key] || 0;
              const scoreColor = ScoringEngine.getScoreColor(score);
              return `
                <div class="breakdown-item">
                  <div class="breakdown-icon" style="background:rgba(108,99,255,0.1)">${info.icon}</div>
                  <div style="flex:1">
                    <div class="breakdown-label">${info.label}</div>
                    <div class="breakdown-desc">${info.desc} • Peso: ${weight}%</div>
                    <div class="breakdown-score-bar mt-2">
                      <div class="progress-bar">
                        <div class="progress-fill" style="width:${score}%;background:${scoreColor}"></div>
                      </div>
                    </div>
                  </div>
                  <div class="breakdown-score-num" style="color:${scoreColor}">${score}</div>
                </div>
              `;
            }).join('')}
          </div>

          <div class="grid-2 grid mb-6">
            <!-- Positives -->
            <div class="card" style="animation:fadeInUp 0.6s var(--ease-out) 0.3s both">
              <h4 style="color:var(--success);margin-bottom:var(--sp-4)">✅ Pontos Fortes</h4>
              ${result.positives.length ? result.positives.map(p => `
                <div class="feedback-item">
                  <span class="feedback-icon">👍</span>
                  <span class="feedback-text">${escHtml(p)}</span>
                </div>
              `).join('') : '<p class="text-muted fs-sm">Nenhum ponto forte identificado desta vez.</p>'}
            </div>

            <!-- Improvements -->
            <div class="card" style="animation:fadeInUp 0.6s var(--ease-out) 0.35s both">
              <h4 style="color:var(--warning);margin-bottom:var(--sp-4)">💡 Pontos de Melhoria</h4>
              ${result.improvements.length ? result.improvements.map(p => `
                <div class="feedback-item">
                  <span class="feedback-icon">📌</span>
                  <span class="feedback-text">${escHtml(p)}</span>
                </div>
              `).join('') : '<p class="text-muted fs-sm">Excelente! Poucos pontos de melhoria.</p>'}
            </div>
          </div>

          <!-- Tips -->
          ${result.tips.length ? `
            <div class="card mb-6" style="animation:fadeInUp 0.6s var(--ease-out) 0.4s both;border-color:rgba(0,212,170,0.2);background:rgba(0,212,170,0.04)">
              <h4 style="color:var(--teal);margin-bottom:var(--sp-4)">🎓 Dicas de Coaching</h4>
              ${result.tips.map(tip => `
                <div class="feedback-item" style="margin-bottom:var(--sp-3);padding:var(--sp-3);background:var(--bg-elevated);border-radius:var(--r-md)">
                  <span class="feedback-icon">💡</span>
                  <div>
                    <div style="font-size:0.8rem;font-weight:700;color:var(--teal);margin-bottom:4px">${escHtml(tip.area)}</div>
                    <span class="feedback-text">${escHtml(tip.tip)}</span>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : ''}

          <!-- Highlight moments -->
          ${result.highlights.length ? `
            <div class="card mb-6" style="animation:fadeInUp 0.6s var(--ease-out) 0.45s both">
              <h4 style="margin-bottom:var(--sp-4)">🔍 Momentos Chave da Conversa</h4>
              ${result.highlights.map(h => `
                <div class="highlight-msg ${h.type}">
                  <div style="font-size:0.78rem;font-weight:700;margin-bottom:4px;color:${h.type==='positive'?'var(--success)':h.type==='negative'?'var(--danger)':'var(--text-muted)'}">
                    ${h.type==='positive'?'✅ Momento Positivo':h.type==='negative'?'⚠️ Ponto de Atenção':'📝 Observação'}
                  </div>
                  <div style="font-style:italic;margin-bottom:4px;color:var(--text-muted)">"${escHtml(h.text)}"</div>
                  <div style="font-size:0.8rem">${escHtml(h.comment)}</div>
                </div>
              `).join('')}
            </div>
          ` : ''}

          <!-- Trigger Usage -->
          ${result.triggerUsage && Object.keys(result.triggerUsage).length > 0 ? `
            <div class="card mb-6" style="animation:fadeInUp 0.6s var(--ease-out) 0.42s both">
              <h4 style="margin-bottom:var(--sp-4)">🧲 Gatilhos de Persuasão Usados</h4>
              <div class="trigger-meter-grid">
                ${Object.entries(result.triggerUsage).map(([key, val]) => {
                  const labels = { autoridade:'Autoridade', provaSocial:'Prova Social', urgencia:'Urgência', especificidade:'Especificidade', empatia:'Empatia', clareza:'Clareza', seguranca:'Segurança', controleExcessivo:'Controle Excessivo' };
                  const isNegative = key === 'controleExcessivo';
                  const color = isNegative ? 'var(--danger)' : val >= 3 ? 'var(--success)' : val >= 1 ? 'var(--warning)' : 'var(--text-muted)';
                  return `
                    <div class="trigger-meter-item">
                      <span class="trigger-meter-label">${labels[key]||key}</span>
                      <div class="trigger-meter-bar">
                        <div style="width:${(val/5)*100}%;background:${color};height:100%;border-radius:2px;transition:width 1s ease"></div>
                      </div>
                      <span class="trigger-meter-val" style="color:${color}">${val}/5</span>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          ` : ''}

          <!-- Style Xray -->
          ${result.styleXray ? `
            <div class="card mb-6" style="animation:fadeInUp 0.6s var(--ease-out) 0.45s both;border-color:rgba(0,212,170,0.15)">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--sp-4)">
                <h4>🔬 Raio-X do Estilo Comercial</h4>
                <div style="font-size:1.5rem;font-weight:800;color:${result.styleXray.xrayScore>=70?'var(--success)':result.styleXray.xrayScore>=45?'var(--warning)':'var(--danger)'}">${result.styleXray.xrayScore}<span style="font-size:0.8rem;color:var(--text-muted)">/100</span></div>
              </div>
              <div class="xray-grid">
                <div class="xray-card">
                  <div class="xray-card-title">❓ Perguntas</div>
                  <div class="xray-stat"><span class="xray-stat-label">Abertas</span><span class="xray-stat-val" style="color:var(--success)">${result.styleXray.openQuestions}</span></div>
                  <div class="xray-stat"><span class="xray-stat-label">Fechadas</span><span class="xray-stat-val" style="color:var(--warning)">${result.styleXray.closedQuestions}</span></div>
                  <div class="xray-stat"><span class="xray-stat-label">% Abertas</span><span class="xray-stat-val">${Math.round(result.styleXray.openQuestionRatio*100)}%</span></div>
                </div>
                <div class="xray-card">
                  <div class="xray-card-title">🚨 Vícios Detectados</div>
                  ${result.styleXray.vicesFound.length === 0 ? '<div class="xray-hint" style="color:var(--success)">✅ Nenhum vício!</div>' : result.styleXray.vicesFound.map(v => `<div class="xray-vice">${v.label}<span>(${v.count}x)</span></div>`).join('')}
                  ${result.styleXray.weakWordsFound.length ? `<div class="xray-card-title" style="margin-top:var(--sp-2)">Palavras Fracas</div>${result.styleXray.weakWordsFound.map(w=>`<div class="xray-vice">"${w}"</div>`).join('')}` : ''}
                </div>
              </div>
            </div>
          ` : ''}

          <!-- Actions -->
          <div class="flex gap-4 flex-wrap" style="justify-content:center;margin-top:var(--sp-8);padding-bottom:var(--sp-16)">
            ${Auth.isSeller() ? `
              <div style="width:100%;margin-bottom:var(--sp-5)">
                <h4 style="margin-bottom:var(--sp-3);text-align:center">🏆 Suas Conquistas</h4>
                ${BadgeSystem.renderBadgeGrid(BadgeSystem.getUserBadges(Auth.getUser()?.id), true)}
              </div>
              <button class="btn btn-primary btn-lg" onclick="App.navigate('seller')">🔄 Nova Sessão</button>
              <button class="btn btn-secondary" onclick="Auth.logout()">← Sair</button>
            ` : `
              <button class="btn btn-primary btn-lg" onclick="App.navigate('manager')">← Voltar ao Painel</button>
            `}
          </div>
        </div>
      </div>
    `;

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'instant' });
    page.scrollTop = 0;

    // Animate score ring and number
    setTimeout(() => {
      const circle = document.getElementById('score-ring-circle');
      const numEl  = document.getElementById('score-number');
      if (circle) circle.style.strokeDashoffset = strokeDashoffset;
      countUp(numEl, 0, score, 1400);
    }, 300);
  }

  function countUp(el, start, end, duration) {
    if (!el) return;
    const startTime = performance.now();
    function update(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(start + (end - start) * eased);
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { render };
})();
