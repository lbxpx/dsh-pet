/**
 * 声音录制向导页面（独立模式专用，仅本机 127.0.0.1）。
 *
 * 为什么是独立页面而不是塞进设置页：提词器需要大字号、倒计时、实时电平，和设置表单争空间；
 * 录制本身还需要麦克风权限与 AudioContext 生命周期，独立页面更容易收口。
 *
 * 录音链路：getUserMedia → AnalyserNode（电平表）+ ScriptProcessor 收集 Float32 PCM →
 * OfflineAudioContext 重采样到 32kHz → 浏览器里直接编码 16-bit PCM WAV → PUT 给宿主质检落盘。
 * 不依赖 ffmpeg/sox：服务端只认这一种 WAV（见 voice-format.ts），P3 的 GPT-SoVITS 也正好要 32k。
 */
export const voicePage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>声音录制向导</title><link rel="stylesheet" href="/standalone-ai/voice.css">
<script src="/standalone-ai/voice.js" defer></script></head><body><main>
<header><p class="local">独立桌宠 / 声线录制</p><h1>声音录制与声线库</h1>
<p class="intro">40 句，约 6–10 分钟。全部在本机完成，录音只保存在 <code>~/.dsh/dsh-pet/voices/</code>。</p></header>

<section id="setup" class="card">
  <label for="voice-name">声音名称</label>
  <input id="voice-name" maxlength="40" placeholder="例如：小蓝" autocomplete="off">
  <label class="check"><input id="consent" type="checkbox">我确认这是本人的声音，并同意用于声线克隆</label>
  <p class="hint">需要麦克风权限。请找安静的环境，离麦克风一拳左右，像平时说话一样朗读。</p>
  <div class="row"><button id="start" disabled>开始录制</button><span id="setup-msg" class="msg" role="status"></span></div>
</section>

<section id="studio" class="card" hidden>
  <div class="topbar"><span id="progress">第 1 / 40 句</span><span id="category" class="tag">音素覆盖</span><button id="finish" class="secondary" type="button" disabled>完成</button></div>
  <p id="hint" class="hint">点「开始录音」，倒计时结束后朗读。</p>
  <p id="sentence" class="sentence"></p>
  <div id="countdown" class="countdown" hidden></div>
  <div class="row"><button id="prev" class="secondary" type="button" disabled>上一句</button><button id="record" type="button">开始录音</button><button id="stop" type="button" hidden>停止</button><button id="redo" class="secondary" type="button" hidden>重录</button><button id="next" class="secondary" type="button" hidden>下一句</button></div>
  <div class="meter"><div class="bar"><i id="level"></i></div><span id="level-text">-∞ dB</span></div>
  <p id="result" class="msg" role="status" aria-live="polite"></p>
  <audio id="playback" controls hidden></audio>
</section>

<section class="card" id="library">
  <div class="topbar"><h2>声线库</h2><button id="refresh" class="secondary" type="button">刷新</button></div>
  <p class="hint">「设为当前」会把桌宠朗读切到这条声线；「试听」用当前本机服务合成同一句，方便横向比较。删除不可恢复，当前使用中的声线需先切换。</p>
  <p id="library-msg" class="msg" role="status" aria-live="polite"></p>
  <div id="voices"></div>
  <p class="hint"><a id="back" href="/standalone-ai/">返回设置</a></p>
</section>
</main></body></html>`;

export const voiceStyle = `
:root{color-scheme:light;--ink:#203b4b;--muted:#526a78;--blue:#12618b;--line:#cbdce5;--paper:#fff;--water:#edf5fa}
*{box-sizing:border-box}body{margin:0;background:var(--water);color:var(--ink);font:16px/1.6 "Microsoft YaHei UI","PingFang SC",sans-serif}
main{max-width:760px;margin:40px auto;padding:0 20px 32px}header{padding:0 8px 20px}.local{font-size:13px;color:var(--muted);margin:0 0 8px}
h1{font-size:30px;letter-spacing:-1px;margin:0 0 12px}.intro{margin:0;color:var(--muted)}code{font:13px/1.5 ui-monospace,Consolas,monospace;background:#e6f0f6;border-radius:4px;padding:1px 5px;word-break:break-all}
.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin:0 0 18px}
label{display:block;font-weight:600;font-size:14px;margin:10px 0 6px}input:not([type=checkbox]){display:block;width:100%;min-height:44px;border:1px solid #a5bdcb;border-radius:6px;padding:9px 12px;font:inherit;font-size:15px;background:#fff}
.check{display:flex;align-items:center;gap:10px;min-height:36px;cursor:pointer;font-weight:500}input[type=checkbox]{width:18px;height:18px;accent-color:var(--blue)}
.hint{font-size:13px;line-height:1.6;color:var(--muted);margin:10px 0 0}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:18px}button{border:0;border-radius:7px;min-height:44px;padding:10px 22px;background:var(--blue);color:#fff;font:600 15px/1.5 inherit;cursor:pointer}button:hover{background:#0b4e73}button:disabled{opacity:.5;cursor:not-allowed}
button.secondary{background:#fff;color:var(--blue);border:1.5px solid var(--blue)}button.secondary:hover{background:#edf5fa}
.msg{font-size:14px;line-height:1.6;margin:12px 0 0;min-height:22px}.msg.err{color:#b3261e;font-weight:600}.msg.ok{color:#1a7f37;font-weight:600}
.topbar{display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap}.tag{font-size:12px;color:var(--blue);background:#e9f3f9;border-radius:999px;padding:3px 12px}
.sentence{font-size:26px;line-height:1.7;font-weight:700;letter-spacing:.5px;margin:26px 0 8px;min-height:80px}
.countdown{font:700 64px/1.2 Georgia,serif;color:var(--blue);text-align:center;margin:8px 0}
.meter{display:flex;align-items:center;gap:12px;margin-top:16px}.bar{flex:1 1 auto;height:12px;border-radius:6px;background:#dbe8f0;overflow:hidden}.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2e9e4f,#e8b62f,#e5453a);transition:width .08s linear}
#level-text{font:12px/1 ui-monospace,Consolas,monospace;color:var(--muted);min-width:64px;text-align:right}
audio{display:block;width:100%;margin-top:14px}a{color:var(--blue)}
.card h2{font-size:20px;margin:0}.voice-item{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 0;border-top:1px solid var(--line);flex-wrap:wrap}
.voice-item:first-child{border-top:0}.voice-name{font-weight:700;font-size:16px}.voice-meta{font-size:12px;color:var(--muted);margin-top:2px;word-break:break-all}
.voice-actions{display:flex;gap:8px;flex-wrap:wrap}.voice-actions button{min-height:34px;padding:5px 12px;font-size:13px;border-radius:6px}
.voice-actions button.danger{background:#fff;color:#a13b30;border:1.5px solid #c4564a}.voice-actions button.danger:hover{background:#fdf0ee}
.badge{font-size:11px;color:#1a7f37;background:#e8f5ec;border-radius:999px;padding:2px 8px;margin-left:6px;vertical-align:middle}
#library-msg{min-height:20px;font-size:13px}#refresh{min-height:34px;padding:5px 14px;font-size:13px}
@media(max-width:560px){main{margin:20px auto}.sentence{font-size:22px}.countdown{font-size:52px}button{width:100%}.row{flex-direction:column;align-items:stretch}}
`;

export const voiceScript = `
'use strict';
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname);
  const get = id => document.getElementById(id);
  const setup = get('setup'), studio = get('studio');
  const TARGET_RATE = 32000;
  let sentences = [];
  let categories = {};
  let session = null;
  let index = 0;
  const results = Object.create(null);
  let stream = null, audioCtx = null, analyser = null, processor = null, muteGain = null;
  let chunks = [];
  let recording = false, recordTimer = null, raf = 0, startedAt = 0;
  let finished = false;

  function setupMessage(message, error) {
    const node = get('setup-msg');
    node.textContent = message || '';
    node.className = 'msg' + (error ? ' err' : '');
  }
  function result(message, kind) {
    const node = get('result');
    node.textContent = message || '';
    node.className = 'msg' + (kind ? ' ' + kind : '');
  }
  function api(path, options) {
    const headers = { 'X-DSH-Pet-Token': token };
    if (options && options.body) headers['Content-Type'] = 'application/json';
    return fetch(path, Object.assign({ credentials: 'omit', cache: 'no-store', headers }, options || {}))
      .then(async response => {
        let data = null;
        try { data = await response.json(); } catch (error) { /* 非 JSON 由下一行统一报 */ }
        if (!response.ok || !data) throw new Error('HTTP ' + response.status);
        if (data.ok === false) throw new Error(data.message || '操作失败');
        return data;
      });
  }
  function refreshStart() {
    get('start').disabled = !(get('voice-name').value.trim().length > 0 && get('consent').checked);
  }
  get('voice-name').addEventListener('input', refreshStart);
  get('consent').addEventListener('change', refreshStart);
  get('back').addEventListener('click', event => {
    event.preventDefault();
    location.href = '/standalone-ai/#token=' + encodeURIComponent(token);
  });

  if (!token) { setupMessage('请从桌宠菜单或本机启动器重新打开设置，再进入录制向导。', true); return; }

  let libraryAudio = null;
  function libraryMessage(message, error) {
    const node = get('library-msg');
    node.textContent = message || '';
    node.className = 'msg' + (error ? ' err' : ' ok');
  }
  function actionButton(label, handler, danger) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = danger ? 'danger' : 'secondary';
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }
  function renderVoices(list) {
    const box = get('voices');
    box.replaceChildren();
    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '还没有完成录制的声线。先在上面录完 40 句并点「完成」。';
      box.appendChild(empty);
      return;
    }
    for (const voice of list) {
      const card = document.createElement('div');
      card.className = 'voice-item';
      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'voice-name';
      title.textContent = voice.name;
      if (voice.active) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '当前使用';
        title.appendChild(badge);
      }
      const meta = document.createElement('div');
      meta.className = 'voice-meta';
      const date = voice.createdAt ? voice.createdAt.slice(0, 10) : '—';
      meta.textContent = voice.recorded + '/' + voice.total + ' 句 · ' + date +
        (voice.refSeconds ? ' · 参考 ' + voice.refSeconds + 's' : '') + ' · ' + voice.id;
      info.appendChild(title);
      info.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'voice-actions';
      const unusable = voice.status !== 'ready' || !voice.recorded;
      const preview = actionButton('试听', () => previewVoice(voice));
      preview.disabled = unusable;
      const active = actionButton('设为当前', () => setActiveVoice(voice));
      active.disabled = unusable || voice.active === true;
      const rename = actionButton('重命名', () => renameVoice(voice));
      const remove = actionButton('删除', () => deleteVoice(voice), true);
      remove.disabled = voice.active === true;
      actions.appendChild(preview);
      actions.appendChild(active);
      actions.appendChild(rename);
      actions.appendChild(remove);
      card.appendChild(info);
      card.appendChild(actions);
      box.appendChild(card);
    }
  }
  async function loadSessions() {
    try {
      const data = await api('/standalone-ai/voice/sessions');
      renderVoices(data.sessions || []);
    } catch (error) {
      libraryMessage('读取声线库失败：' + (error && error.message ? error.message : String(error)), true);
    }
  }
  async function previewVoice(voice) {
    try {
      libraryMessage('正在用「' + voice.name + '」合成试听…');
      const data = await api('/standalone-ai/tts/test', {
        method: 'POST',
        body: JSON.stringify({ provider: 'local', voiceId: voice.id, rate: 0 })
      });
      if (!data.url) throw new Error(data.message || '没有返回试听音频');
      if (libraryAudio) { libraryAudio.pause(); libraryAudio = null; }
      libraryAudio = new Audio(data.url);
      libraryAudio.addEventListener('ended', () => libraryMessage('✓ 「' + voice.name + '」试听完成'));
      await libraryAudio.play();
      libraryMessage('▶ 正在播放「' + voice.name + '」的试听');
    } catch (error) {
      libraryMessage('✗ ' + (error && error.message ? error.message : String(error)), true);
    }
  }
  async function setActiveVoice(voice) {
    try {
      await api('/standalone-ai/voice/active', { method: 'POST', body: JSON.stringify({ id: voice.id }) });
      libraryMessage('✓ 已把「' + voice.name + '」设为当前声线，朗读会立即使用它');
      await loadSessions();
    } catch (error) {
      libraryMessage('✗ ' + (error && error.message ? error.message : String(error)), true);
    }
  }
  async function renameVoice(voice) {
    const name = prompt('新的声音名称（1–40 字）', voice.name);
    if (name === null) return;
    try {
      await api('/standalone-ai/voice/session/' + encodeURIComponent(voice.id), {
        method: 'PATCH',
        body: JSON.stringify({ name })
      });
      libraryMessage('✓ 已重命名为「' + name.trim() + '」');
      await loadSessions();
    } catch (error) {
      libraryMessage('✗ ' + (error && error.message ? error.message : String(error)), true);
    }
  }
  async function deleteVoice(voice) {
    if (!confirm('删除「' + voice.name + '」？录音与 manifest 会一起删除，且不可恢复。')) return;
    try {
      await api('/standalone-ai/voice/session/' + encodeURIComponent(voice.id), { method: 'DELETE' });
      libraryMessage('✓ 已删除「' + voice.name + '」');
      await loadSessions();
    } catch (error) {
      libraryMessage('✗ ' + (error && error.message ? error.message : String(error)), true);
    }
  }
  get('refresh').addEventListener('click', () => { void loadSessions(); });
  void loadSessions();

  api('/standalone-ai/voice/script')
    .then(data => {
      sentences = data.sentences || [];
      categories = data.categories || {};
      if (sentences.length === 0) throw new Error('句子库为空');
      refreshStart();
      setupMessage('句子库已就绪，填好名称并勾选同意后开始。');
    })
    .catch(error => setupMessage(error.message, true));

  function friendlyMicError(error) {
    const name = error && error.name ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝：请允许本页使用麦克风后重试。';
    if (name === 'NotFoundError') return '没有找到麦克风：请检查设备是否连接。';
    if (name === 'NotReadableError') return '麦克风被其它程序占用：关掉占用它的软件后重试。';
    return '无法打开麦克风：' + (error && error.message ? error.message : String(error));
  }

  get('start').addEventListener('click', async () => {
    get('start').disabled = true;
    setupMessage('正在请求麦克风…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }
      });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = event => {
        if (recording) chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      // 静音输出：ScriptProcessor 必须有下游才会持续触发，但不能把麦克风声音放出来（啸叫）
      muteGain = audioCtx.createGain();
      muteGain.gain.value = 0;
      source.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(audioCtx.destination);
      const data = await api('/standalone-ai/voice/session', {
        method: 'POST',
        body: JSON.stringify({ name: get('voice-name').value.trim(), consent: get('consent').checked })
      });
      session = data.session;
      setup.hidden = true;
      studio.hidden = false;
      showSentence(0);
    } catch (error) {
      setupMessage(friendlyMicError(error), true);
      get('start').disabled = false;
    }
  });

  function showSentence(next) {
    index = Math.max(0, Math.min(sentences.length - 1, next));
    const sentence = sentences[index];
    get('progress').textContent = '第 ' + (index + 1) + ' / ' + sentences.length + ' 句' + (results[sentence.id] ? '（已录）' : '');
    get('category').textContent = categories[sentence.category] || sentence.category;
    get('sentence').textContent = sentence.text;
    get('hint').textContent = '点「开始录音」，倒计时结束后朗读；最多 ' + sentence.maxSec + ' 秒，读完可点「停止」。';
    get('prev').hidden = false;
    get('prev').disabled = index === 0;
    get('record').hidden = false;
    get('record').disabled = false;
    get('stop').hidden = true;
    get('redo').hidden = true;
    get('next').hidden = true;
    get('playback').hidden = true;
    get('finish').disabled = Object.keys(results).length === 0;
    result('');
  }

  get('record').addEventListener('click', () => {
    get('prev').disabled = true;
    get('record').hidden = true;
    get('stop').hidden = true;
    get('redo').hidden = true;
    get('next').hidden = true;
    let count = 3;
    get('countdown').hidden = false;
    get('countdown').textContent = String(count);
    result('准备…');
    const tick = () => {
      count -= 1;
      if (count > 0) {
        get('countdown').textContent = String(count);
        setTimeout(tick, 1000);
      } else {
        get('countdown').hidden = true;
        startRecording();
      }
    };
    setTimeout(tick, 1000);
  });
  get('stop').addEventListener('click', () => { void stopRecording(); });
  get('prev').addEventListener('click', () => { if (!recording) showSentence(index - 1); });
  get('redo').addEventListener('click', () => { showSentence(index); get('record').click(); });
  get('next').addEventListener('click', () => {
    if (index < sentences.length - 1) showSentence(index + 1);
    else result('已经是最后一句，点「完成」生成参考音频。', 'ok');
  });

  function startRecording() {
    const sentence = sentences[index];
    chunks = [];
    recording = true;
    startedAt = performance.now();
    get('stop').hidden = false;
    get('stop').disabled = false;
    get('hint').textContent = '录音中…请自然朗读（最多 ' + sentence.maxSec + ' 秒）';
    result('录音中…');
    recordTimer = setTimeout(() => { void stopRecording(); }, sentence.maxSec * 1000);
    meterLoop();
  }

  function meterLoop() {
    if (!analyser || !recording) return;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
    const db = 20 * Math.log10(Math.sqrt(sum / data.length) || 1e-8);
    const percent = Math.max(0, Math.min(1, (db + 60) / 60));
    get('level').style.width = (percent * 100).toFixed(1) + '%';
    get('level-text').textContent = db > -60 ? Math.round(db) + ' dB' : '-∞ dB';
    raf = requestAnimationFrame(meterLoop);
  }

  function mergeChunks(list) {
    let length = 0;
    for (const chunk of list) length += chunk.length;
    const out = new Float32Array(length);
    let offset = 0;
    for (const chunk of list) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  async function encodeWav(samples, sourceRate) {
    let data = samples;
    if (Math.abs(sourceRate - TARGET_RATE) > 1) {
      const length = Math.max(1, Math.ceil(samples.length * TARGET_RATE / sourceRate));
      const offline = new OfflineAudioContext(1, length, TARGET_RATE);
      const buffer = offline.createBuffer(1, samples.length, sourceRate);
      buffer.copyToChannel(samples, 0);
      const source = offline.createBufferSource();
      source.buffer = buffer;
      source.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      data = rendered.getChannelData(0);
    }
    const bytes = new ArrayBuffer(44 + data.length * 2);
    const view = new DataView(bytes);
    const write = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
    write(0, 'RIFF');
    view.setUint32(4, 36 + data.length * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, TARGET_RATE, true);
    view.setUint32(28, TARGET_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, data.length * 2, true);
    let offset = 44;
    for (let i = 0; i < data.length; i += 1, offset += 2) {
      const value = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    return bytes;
  }

  async function stopRecording() {
    if (!recording) return;
    recording = false;
    clearTimeout(recordTimer);
    cancelAnimationFrame(raf);
    get('stop').hidden = true;
    get('record').hidden = true;
    const elapsed = (performance.now() - startedAt) / 1000;
    if (elapsed < 0.5 || chunks.length === 0) {
      result('录音太短，请重试', 'err');
      get('record').hidden = false;
      return;
    }
    const sentence = sentences[index];
    try {
      result('正在转换为 WAV…');
      const wav = await encodeWav(mergeChunks(chunks), audioCtx.sampleRate);
      result('正在上传并质检…');
      const response = await fetch(
        '/standalone-ai/voice/session/' + encodeURIComponent(session.id) + '/clip/' + sentence.id,
        {
          method: 'PUT',
          credentials: 'omit',
          cache: 'no-store',
          headers: { 'X-DSH-Pet-Token': token, 'Content-Type': 'audio/wav' },
          body: new Blob([wav], { type: 'audio/wav' })
        }
      );
      let data = null;
      try { data = await response.json(); } catch (error) { /* 下面统一报 */ }
      if (!response.ok || !data) throw new Error('上传失败：HTTP ' + response.status);
      if (data.ok === false) throw new Error(data.message || '质检未通过');
      results[sentence.id] = data.clip;
      get('progress').textContent = '第 ' + (index + 1) + ' / ' + sentences.length + ' 句（已录）';
      const metrics = data.clip.metrics;
      const summary = '时长 ' + metrics.durationSec + 's · 峰值 ' + metrics.peakDb + 'dB · 底噪 ' +
        metrics.noiseFloorDb + 'dB · ' + metrics.charsPerSecond + ' 字/秒';
      const playback = get('playback');
      playback.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      playback.hidden = false;
      get('finish').disabled = false;
      if (data.issues.length === 0) {
        result('✓ 通过 · ' + summary + (data.warnings.length ? ' · ' + data.warnings.join('；') : ''), 'ok');
        if (index < sentences.length - 1) {
          get('next').hidden = false;
          const advancedFrom = index;
          setTimeout(() => {
            // 用户在 1.4 秒内自己点了「下一句」/ 重录，就不要再自动跳一次
            if (index === advancedFrom && !recording && !finished) showSentence(index + 1);
          }, 1400);
        } else {
          result('全部句子已录完，点右上角「完成」生成参考音频。', 'ok');
        }
      } else {
        result('✗ ' + data.issues.join('；') + '（' + summary + '）', 'err');
        get('redo').hidden = false;
        get('next').hidden = false;
        get('prev').disabled = index === 0;
      }
    } catch (error) {
      result('录音未保存：' + (error && error.message ? error.message : String(error)), 'err');
      get('record').hidden = false;
      get('record').disabled = false;
      get('prev').disabled = index === 0;
    }
  }

  get('finish').addEventListener('click', async () => {
    get('finish').disabled = true;
    result('正在生成参考音频并写 manifest…');
    try {
      const data = await api('/standalone-ai/voice/session/' + encodeURIComponent(session.id) + '/finish', {
        method: 'POST',
        body: '{}'
      });
      finished = true;
      result('✓ 完成：' + data.session.dir + '（共 ' + data.session.recorded + ' 句，参考音频 ' + data.ref + '）', 'ok');
      void loadSessions();
      get('record').hidden = true;
      get('redo').hidden = true;
      get('next').hidden = true;
      get('prev').hidden = true;
      get('playback').hidden = true;
    } catch (error) {
      get('finish').disabled = false;
      result('生成失败：' + (error && error.message ? error.message : String(error)), 'err');
    }
  });

  window.addEventListener('beforeunload', event => {
    if (session && !finished) {
      event.preventDefault();
      event.returnValue = '录音还没完成，离开会丢失已录内容（已上传的句子仍保存在 voices 目录）。';
    }
  });
})();
`;
