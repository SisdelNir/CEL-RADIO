// CEL-RADIO — Radio PTT Logic
(async function() {
  'use strict';

  // ============ AUTH CHECK ============
  const auth = JSON.parse(sessionStorage.getItem('cel_auth') || 'null');
  if (!auth || auth.role !== 'user') {
    window.location.href = 'index.html';
    // Return to prevent further execution (in browser environment)
  }

  // ============ LOAD DATA ============
  let tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
  
  let channels = [];
  try {
    const res = await fetch(`/api/canales/${tenant.id}`).catch(() => null);
    if (res && res.ok) {
       const rawChannels = await res.json();
       // Mapear campos de la API (nombre, icono...) al formato interno (name, icon...)
       channels = rawChannels
         .filter(c => c.estado === 'activo')
         .map(c => ({
           id: c.id,
           name: c.nombre,
           icon: c.icono || '📻',
           type: c.tipo || 'grupo',
           users: 0,
           mode: c.modo || 'ptt'
         }));
    }
  } catch (e) {
    console.warn('Error loading channels:', e);
  }
  
  // Limpiar caché local obsoleta
  const chKey = tenant.id ? `cel_channels_${tenant.id}` : 'cel_channels';
  localStorage.removeItem(chKey);

  let users = [];
  try {
    const res = await fetch(`/api/usuarios/${tenant.id}`).catch(() => null);
    if (res && res.ok) {
      const rawUsers = await res.json();
      users = rawUsers.map(u => ({
        id: u.id,
        name: u.nombre,
        initials: (u.nombre || 'P').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase(),
        role: u.rol || 'Piloto',
        online: u.estado === 'en_linea' || u.estado === 'activo'
      }));
    }
  } catch (e) {
    console.warn('Error loading users:', e);
  }

  // Limpiar caché local obsoleta
  const usrKey = tenant.id ? `cel_users_${tenant.id}` : 'cel_users';
  localStorage.removeItem(usrKey);

  // ============ STATE ============
  let currentChannel = null;
  let isTransmitting = false;
  let currentPrivateUser = null;

  // Real-time Audio state
  let socket = null;
  if (typeof io !== 'undefined') {
    socket = io();
  } else {
    console.warn("Socket.io no cargó correctamente");
  }

  let mediaRecorder = null;
  let currentRoom = null;
  let micStream = null;

  // Hands-free state
  let isHandsFreeMode = false;
  let handsFreeRecorder = null;

  // Arbitration state
  let speakGranted = false;
  let transmitTimeout = null;
  const MAX_LOCAL_SPEAK = 15000; // 15 segundos

  // AudioContext for playback
  let globalAudioCtx = null;

  // ═══ WebRTC Media Client (Mediasoup SFU) ═══
  let radioMedia = null;
  let useWebRTC = false; // Se activa si mediasoup-client está disponible

  // ============ INIT ============
  async function init() {
    loadTenantInfo();
    updateChannelDisplay();
    setupPTT();
    setupModals();
    setupEmergency();
    setupHandsFree();
    requestMicrophone();
    setupSocketReceivers();
    await initWebRTC();
    
    // Unlock iOS audio on first touch
    const unlockAudio = () => {
      if (!globalAudioCtx) globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (globalAudioCtx.state === 'suspended') globalAudioCtx.resume();
      const la = document.getElementById('liveAudio');
      if (la) la.play().then(() => la.pause()).catch(()=>{});
      
      // Iniciar el reconocimiento de voz de fondo al primer toque
      startVoiceRecognition();
      
      document.body.removeEventListener('touchstart', unlockAudio);
      document.body.removeEventListener('click', unlockAudio);
    };
    document.body.addEventListener('touchstart', unlockAudio, { once: true });
    document.body.addEventListener('click', unlockAudio, { once: true });
  }

  async function requestMicrophone() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      console.log('[Mic] Micrófono activado correctamente');
    } catch (err) {
      console.warn("Microphone access denied or error:", err);
      showToast("⚠️ Activa el permiso del micrófono");
    }
  }

  function setupSocketReceivers() {
    if (!socket) return;
    
    const tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
    const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
    if (tenant.id && loggedInUser.id) {
      socket.emit('register_user', { empresaId: tenant.id, userId: loggedInUser.id, userName: loggedInUser.nombre });
    }
    
    socket.on('user_status_changed', (data) => {
      const { userId, isOnline } = data;
      const u = users.find(x => x.id === userId);
      if (u) {
        u.online = isOnline;
        if (document.getElementById('privateModal').classList.contains('active')) renderUsers();
        // Actualizar punto verde en llamada privada activa
        if (currentPrivateUser && currentPrivateUser.id === userId) {
          updateChannelDisplay();
        }
      }
    });
    
    socket.on('incoming_private_call', (data) => {
      const { roomName, caller } = data;
      currentChannel = null;
      currentPrivateUser = { id: caller.id, name: caller.nombre, initials: caller.initials };
      document.getElementById('channelModal').classList.remove('active');
      document.getElementById('privateModal').classList.remove('active');
      updateChannelDisplay();
      showToast(`📞 Llamada entrante de ${caller.nombre}`);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    });
    
    // Recibir señal de que el otro usuario activó modo teléfono
    socket.on('open_mic_request', (data) => {
      // INTEGRIDAD: Solo aceptar si estamos en llamada privada con ese usuario exacto
      if (!currentPrivateUser || !data.fromUserId) return;
      if (currentPrivateUser.id !== data.fromUserId) return; // No es nuestro interlocutor
      // Verificar que compartimos la misma sala privada
      const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
      const _tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
      const expectedRoom = `private_${_tenant.id}_${Math.min(loggedInUser.id, data.fromUserId)}_${Math.max(loggedInUser.id, data.fromUserId)}`;
      if (currentRoom !== expectedRoom) return; // No somos parte de esa sala

      if (!isHandsFreeMode) {
        isHandsFreeMode = true;
        const btn = document.getElementById('btnHandsFree');
        btn.classList.add('active');
        enterPhoneCallMode();
        showToast(`📞 ${data.fromUserName} activó modo llamada`);
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      }
    });
    
    // Recibir señal de que el otro usuario colgó
    socket.on('open_mic_ended', (data) => {
      if (isHandsFreeMode && currentPrivateUser) {
        isHandsFreeMode = false;
        const btn = document.getElementById('btnHandsFree');
        btn.classList.remove('active');
        exitPhoneCallMode();
        stopTransmit(false);
        showToast(`📞 ${data.fromUserName || 'El otro usuario'} terminó la llamada`);
      }
    });
    
    // Conteo de usuarios en el canal
    socket.on('channel_user_count', (data) => {
      if (currentChannel && data.room && data.room.includes(`canal_${currentChannel.id}`)) {
        currentChannel.users = data.count;
        const countEl = document.getElementById('userCount');
        if (countEl) countEl.textContent = data.count;
      }
    });
    
    // ── Recibir audio ──
    // Si WebRTC (Mediasoup) está activo, el audio llega vía WebRTC tracks automáticamente.
    // El fallback Socket.io solo se usa cuando Mediasoup NO está disponible.
    let speakerTimeout = null;
    const audioQueue = [];
    let isPlaying = false;
    
    async function playNextInQueue() {
      if (audioQueue.length === 0) {
        isPlaying = false;
        clearTimeout(speakerTimeout);
        speakerTimeout = setTimeout(() => hideSpeaker(), 2000);
        return;
      }
      isPlaying = true;
      const { audioBlob, mimeType, sender } = audioQueue.shift();
      showSpeaker(sender.name, sender.initials, false);
      clearTimeout(speakerTimeout);
      speakerTimeout = setTimeout(() => hideSpeaker(), 10000);
      
      try {
        if (!globalAudioCtx) globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (globalAudioCtx.state === 'suspended') await globalAudioCtx.resume();
        const blob = new Blob([audioBlob], { type: mimeType || 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await globalAudioCtx.decodeAudioData(arrayBuffer);
        const source = globalAudioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(globalAudioCtx.destination);
        source.onended = () => playNextInQueue();
        source.start(0);
      } catch (err) {
        console.warn('AudioContext decode failed, trying <audio> fallback:', err);
        try {
          const blob = new Blob([audioBlob], { type: mimeType || 'audio/webm' });
          const url = URL.createObjectURL(blob);
          const liveAudio = document.getElementById('liveAudio');
          if (liveAudio) {
            liveAudio.src = url;
            liveAudio.onended = () => { URL.revokeObjectURL(url); playNextInQueue(); };
            liveAudio.onerror = () => { URL.revokeObjectURL(url); playNextInQueue(); };
            await liveAudio.play();
          } else { playNextInQueue(); }
        } catch (fallbackErr) {
          console.warn('Audio fallback also failed:', fallbackErr);
          playNextInQueue();
        }
      }
    }
    
    // FALLBACK: Solo se usa cuando Mediasoup NO está activo
    socket.on('receive_voice', (data) => {
      if (useWebRTC) return; // WebRTC maneja el audio directamente
      const { audioBlob, sender, mimeType, room: senderRoom } = data;
      if (!audioBlob) return;
      // INTEGRIDAD DE CANAL: Solo reproducir si el audio proviene de nuestra sala activa
      if (senderRoom && currentRoom && senderRoom !== currentRoom) return;
      audioQueue.push({ audioBlob, sender, mimeType });
      if (!isPlaying) playNextInQueue();
    });
    
    // ====== ARBITRAJE DE VOZ (respuestas del servidor) ======
    socket.on('SPEAK_GRANTED', (data) => {
      console.log('[Arbitraje] GRANTED recibido');
      speakGranted = true;
      // La grabación ya está en curso — no hacer nada más
    });
    
    socket.on('SPEAK_DENIED', (data) => {
      console.log('[Arbitraje] DENIED:', data.occupiedBy);
      showToast(`⏳ ${data.occupiedBy} está hablando`);
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      // Detener la grabación que ya inició (descartar audio)
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.ondataavailable = null; // No enviar lo grabado
        mediaRecorder.stop();
      }
      isTransmitting = false;
      speakGranted = false;
      clearTimeout(transmitTimeout);
      const btn = document.getElementById('pttBtn');
      btn.classList.remove('transmitting');
      document.getElementById('pttLabel').textContent = 'HABLAR';
      document.getElementById('pttHint').textContent = 'Mantener presionado para hablar';
      hideSpeaker();
    });
    
    socket.on('SPEAK_TIMEOUT', (data) => {
      console.log('[Arbitraje] TIMEOUT del servidor');
      showToast('⏱️ Tiempo máximo alcanzado (15s)');
      stopTransmit(false);
    });
    
    socket.on('SOMEONE_SPEAKING', (data) => {
      // INTEGRIDAD: Descartar si el evento proviene de una sala distinta a la actual
      if (currentRoom && data.room !== currentRoom) {
        console.warn(`[Crosstalk UI Evitado] SOMEONE_SPEAKING de ${data.room} ignorado en ${currentRoom}`);
        return;
      }
      // Alguien más empezó a hablar — mostrar indicador
      if (!isTransmitting) {
        showSpeaker(data.speakerName, data.speakerName.slice(0,2).toUpperCase(), false);
      }
    });
    
    socket.on('SPEAK_RELEASED', (data) => {
      // El canal fue liberado
      if (!isTransmitting) {
        hideSpeaker();
      }
    });
  }

  function loadTenantInfo() {
    // Try cel_empresa first
    let tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || '{}');
    
    if (tenant.nombre || tenant.name) {
      const name = tenant.nombre || tenant.name;
      document.getElementById('companyName').textContent = name;
      document.getElementById('companyLogo').textContent = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    } else {
      document.getElementById('companyName').textContent = "SIN EMPRESA";
    }

    // Display current user
    const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
    const userName = loggedInUser.nombre || 'Modo Prueba';
    const userDisplay = document.getElementById('currentUserDisplay');
    const userToggle = document.getElementById('userStatusToggle');
    const userDot = document.getElementById('userStatusDot');
    
    // Estado local inicial
    let isLocalOnline = true;
    
    if (userDisplay) {
      userDisplay.textContent = `${userName}`;
    }
    
    if (userToggle) {
      userToggle.addEventListener('click', () => {
        isLocalOnline = !isLocalOnline;
        if (isLocalOnline) {
          userDot.classList.remove('offline');
          userDisplay.textContent = userName;
          showToast("Has cambiado a: Visible");
        } else {
          userDot.classList.add('offline');
          userDisplay.textContent = `${userName} (Oculto)`;
          showToast("Has cambiado a: Oculto");
        }
        
        if (socket && tenant.id && loggedInUser.id) {
          socket.emit('toggle_status', { empresaId: tenant.id, userId: loggedInUser.id, isOnline: isLocalOnline });
        }
      });
    }
  }

  // ============ CHANNEL DISPLAY ============
  function updateChannelDisplay() {
    const nameEl = document.getElementById('channelName');
    const labelEl = document.getElementById('channelLabel');
    const usersEl = document.getElementById('channelUsersText');
    const idleIcon = document.getElementById('idleIcon');
    const idleText = document.getElementById('idleText');
    
    if (!currentChannel && !currentPrivateUser) {
      labelEl.textContent = 'Estado de Conexión';
      nameEl.textContent = '🚫 Sin Conexión';
      usersEl.textContent = 'Selecciona un canal o usuario';
      idleIcon.textContent = '🔇';
      idleText.textContent = 'Aislado — Conéctate para escuchar';
    } else if (currentPrivateUser) {
      const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
      const myName = loggedInUser.nombre || 'TÚ';

      labelEl.textContent = '📞 LLAMADA PRIVADA';
      // Verificar si el otro usuario está en línea
      const otherUser = users.find(u => u.id === currentPrivateUser.id);
      const isOtherOnline = otherUser ? otherUser.online : false;
      const dotColor = isOtherOnline ? '#10b981' : '#64748b';
      const dotGlow = isOtherOnline ? 'box-shadow:0 0 8px #10b981;' : '';
      const statusLabel = isOtherOnline ? 'En línea' : 'Desconectado';
      
      nameEl.innerHTML = `<div class="private-names">
        <div class="caller-name">${myName}</div>
        <div class="divider-icon">📞 ↕️</div>
        <div class="callee-name" style="display:flex;align-items:center;justify-content:center;gap:8px;">
          <span style="width:12px;height:12px;border-radius:50%;background:${dotColor};${dotGlow}display:inline-block;flex-shrink:0;"></span>
          ${currentPrivateUser.name}
        </div>
      </div>`;
      usersEl.innerHTML = '<span style="color:' + dotColor + ';">● ' + statusLabel + '</span> — Comunicación privada enlazada';
      idleIcon.textContent = '📞';
      idleText.textContent = isOtherOnline ? 'Línea privada — listo para hablar' : '⚠️ El otro usuario no está conectado';
      
      if (socket) {
        let tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
        const roomName = `private_${tenant.id}_${Math.min(loggedInUser.id, currentPrivateUser.id)}_${Math.max(loggedInUser.id, currentPrivateUser.id)}`;
        currentRoom = roomName;
        socket.emit('join_channel', { channelId: roomName, empresaId: tenant.id, userName: loggedInUser.nombre, tipo: 'privado' });
        // Unir WebRTC a la sala de medios
        if (radioMedia && useWebRTC) radioMedia.joinRoom(roomName);
      }
    } else {
      labelEl.textContent = 'Canal Activo';
      nameEl.textContent = `📻 ${currentChannel.name}`;
      usersEl.innerHTML = `👥 Total Empresa: ${users.length} | 🟢 En Canal: <span id="userCount">${currentChannel.users}</span>`;
      idleIcon.textContent = currentChannel.icon || '📻';
      idleText.textContent = 'Canal libre — listo para hablar';
      
      if (socket) {
        let tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
        const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
        currentRoom = `empresa_${tenant.id}_canal_${currentChannel.id}`;
        socket.emit('join_channel', { channelId: currentChannel.id, empresaId: tenant.id, userName: loggedInUser.nombre, tipo: 'grupo' });
        // Unir WebRTC a la sala de medios
        if (radioMedia && useWebRTC) radioMedia.joinRoom(currentRoom);
      }
    }
    // Actualizar estado del botón de llamada según contexto
    updateHandsFreeButton();
  }

  // Hands-free voice recognition state
  let recognition = null;
  let isListening = false;
  let handsFreeTimer = null;

  // ============ MICRÓFONO ABIERTO (Solo Llamadas Privadas — Modo Teléfono) ============
  let callTimerInterval = null;
  let callStartTime = null;

  function setupHandsFree() {
    const btn = document.getElementById('btnHandsFree');
    if (!btn) return;
    
    btn.addEventListener('click', () => {
      // Solo funciona en llamadas privadas
      if (!currentPrivateUser) {
        showToast('📞 Solo disponible en llamadas privadas');
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
        return;
      }
      
      isHandsFreeMode = !isHandsFreeMode;
      btn.classList.toggle('active', isHandsFreeMode);
      
      if (isHandsFreeMode) {
        // Activar modo teléfono
        enterPhoneCallMode();
        startTransmit();
        
        // Notificar al otro usuario para que también abra su micrófono
        const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
        const tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || '{}');
        if (socket && currentPrivateUser) {
          const targetRoom = `empresa_${tenant.id}_user_${currentPrivateUser.id}`;
          socket.emit('relay_to_user', {
            targetRoom,
            event: 'open_mic_request',
            data: { fromUserId: loggedInUser.id, fromUserName: loggedInUser.nombre }
          });
        }
      } else {
        // Colgar
        hangUpPhoneCall();
      }
    });
  }

  function enterPhoneCallMode() {
    // Cambiar PTT a botón de COLGAR
    const pttBtn = document.getElementById('pttBtn');
    const pttLabel = document.getElementById('pttLabel');
    const pttHint = document.getElementById('pttHint');
    pttBtn.classList.add('active');
    pttBtn.style.background = 'linear-gradient(145deg, #dc2626, #b91c1c)';
    pttBtn.style.boxShadow = '0 0 30px rgba(220, 38, 38, 0.4)';
    pttBtn.style.borderColor = 'rgba(220, 38, 38, 0.5)';
    pttLabel.textContent = 'COLGAR';
    pttHint.textContent = '';
    
    // Mostrar indicador de llamada con cronómetro
    callStartTime = Date.now();
    const voiceInd = document.getElementById('voiceIndicator');
    voiceInd.style.display = 'block';
    voiceInd.style.background = 'rgba(16, 185, 129, 0.15)';
    voiceInd.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    updateCallTimer();
    callTimerInterval = setInterval(updateCallTimer, 1000);
    
    showToast(`📞 Llamada activa con ${currentPrivateUser.name}`);
    if (navigator.vibrate) navigator.vibrate(100);
    
    // Hacer que el botón PTT funcione como COLGAR
    pttBtn._phoneCallHandler = () => {
      isHandsFreeMode = false;
      document.getElementById('btnHandsFree').classList.remove('active');
      hangUpPhoneCall();
    };
    pttBtn.addEventListener('click', pttBtn._phoneCallHandler);
  }

  function updateCallTimer() {
    if (!callStartTime) return;
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    const voiceInd = document.getElementById('voiceIndicator');
    voiceInd.textContent = `📞 En llamada con ${currentPrivateUser ? currentPrivateUser.name : '...'} — ${mins}:${secs}`;
  }

  function exitPhoneCallMode() {
    // Restaurar botón PTT
    const pttBtn = document.getElementById('pttBtn');
    pttBtn.classList.remove('active');
    pttBtn.style.background = '';
    pttBtn.style.boxShadow = '';
    pttBtn.style.borderColor = '';
    document.getElementById('pttLabel').textContent = 'HABLAR';
    document.getElementById('pttHint').textContent = 'Mantener presionado para hablar';
    
    // Quitar handler de colgar
    if (pttBtn._phoneCallHandler) {
      pttBtn.removeEventListener('click', pttBtn._phoneCallHandler);
      pttBtn._phoneCallHandler = null;
    }
    
    // Detener cronómetro
    clearInterval(callTimerInterval);
    callTimerInterval = null;
    callStartTime = null;
    
    // Ocultar indicador
    const voiceInd = document.getElementById('voiceIndicator');
    voiceInd.style.display = 'none';
    voiceInd.style.background = '';
    voiceInd.style.borderColor = '';
  }

  function hangUpPhoneCall() {
    // Notificar al otro usuario
    const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
    const tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || '{}');
    if (socket && currentPrivateUser) {
      const targetRoom = `empresa_${tenant.id}_user_${currentPrivateUser.id}`;
      socket.emit('relay_to_user', {
        targetRoom,
        event: 'open_mic_ended',
        data: { fromUserId: loggedInUser.id, fromUserName: loggedInUser.nombre }
      });
    }
    
    exitPhoneCallMode();
    stopTransmit(false);
    showToast('📞 Llamada terminada');
  }

  // Actualizar estado visual del botón Micrófono Abierto
  function updateHandsFreeButton() {
    const btn = document.getElementById('btnHandsFree');
    if (!btn) return;
    if (currentPrivateUser) {
      // Mostrar solo en llamada privada
      btn.style.display = 'flex';
      btn.style.pointerEvents = 'auto';
      btn.style.cursor = 'pointer';
      btn.querySelector('span:last-child').textContent = isHandsFreeMode ? 'Llamada Activa' : 'Activar Llamada';
      btn.title = 'Activar llamada de voz continua';
    } else {
      // Ocultar completamente fuera de llamada privada
      btn.style.display = 'none';
      // Si estaba en modo llamada, desactivar
      if (isHandsFreeMode) {
        isHandsFreeMode = false;
        btn.classList.remove('active');
        exitPhoneCallMode();
        stopTransmit(false);
      }
    }
  }
  
  function startVoiceRecognition() {
    if (isListening) return;
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      console.warn('Tu navegador no soporta reconocimiento de voz continuo.');
      return;
    }
    
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'es-ES';

    recognition.onstart = function() {
      isListening = true;
      if (isHandsFreeMode) {
        document.getElementById('voiceIndicator').style.display = 'block';
      }
    };

    recognition.onresult = function(event) {
      if (isTransmitting) return;
      
      const transcript = event.results[event.results.length - 1][0].transcript.toLowerCase();
      console.log('🗣️ Voz detectada:', transcript);
      
      // Buscar frase "atento atento"
      if (transcript.includes('atento atento') || transcript.includes('atento, atento')) {
        
        // Extraer nombre del canal, ej: "atento atento arena"
        let phrase = transcript.replace(/.*atento[,\s]*atento\s*/, '').trim();
        
        // Buscar el canal en la lista
        let targetChannel = null;
        if (phrase) {
          // Buscamos si alguna palabra en la frase coincide con el nombre de un canal
          targetChannel = channels.find(c => phrase.includes(c.name.toLowerCase()));
        }
        
        if (targetChannel) {
          // Cambiar a ese canal automáticamente
          currentChannel = targetChannel;
          currentPrivateUser = null;
          updateChannelDisplay();
          showToast(`📻 Cambiando a Canal: ${targetChannel.name} por voz`);
        } else if (!currentChannel && !currentPrivateUser) {
           showToast('⚠️ No se entendió el canal y no estás conectado a ninguno');
           return; // Abortar si no hay canal de destino
        }
        
        // ACTIVAR TRANSMISIÓN
        // La propia función startTransmit ya tiene su timeout por inactividad de 15s
        startTransmit();
        showToast('🎙️ Transmisión manos libres activada');
      }
    };

    recognition.onerror = function(event) {
      console.warn('Speech recognition error:', event.error);
    };

    recognition.onend = function() {
      isListening = false;
      // Reiniciar SIEMPRE (Background global)
      try { recognition.start(); } catch(e) {}
    };

    try {
      recognition.start();
    } catch (e) {
      console.error('Error starting recognition:', e);
    }
  }

  function stopVoiceRecognition() {
    if (recognition) {
      recognition.onend = null; // No reiniciar
      recognition.stop();
      recognition = null;
      isListening = false;
      document.getElementById('voiceIndicator').style.display = 'none';
    }
  }

  // ============ VOICE ACTIVITY DETECTION (VAD) ============
  let vadAudioCtx = null;
  let vadAnalyser = null;
  let vadSource = null;
  let isCheckingVad = false;

  function startVAD() {
    if (!micStream) return;
    
    if (!vadAudioCtx) {
      vadAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    if (!vadAnalyser) {
      vadAnalyser = vadAudioCtx.createAnalyser();
      vadAnalyser.fftSize = 256;
      vadSource = vadAudioCtx.createMediaStreamSource(micStream);
      vadSource.connect(vadAnalyser);
    }
    
    if (vadAudioCtx.state === 'suspended') vadAudioCtx.resume();
    
    isCheckingVad = true;
    checkVADLevel();
  }
  
  function checkVADLevel() {
    if (!isCheckingVad || !isTransmitting) return;
    
    const dataArray = new Uint8Array(vadAnalyser.frequencyBinCount);
    vadAnalyser.getByteFrequencyData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    let average = sum / dataArray.length;
    
    // Umbral de ruido para considerarlo "habla" (10 sobre 255)
    if (average > 10) {
      // Reseteamos el timeout de inactividad
      clearTimeout(transmitTimeout);
      transmitTimeout = setTimeout(() => {
        showToast('⏱️ Transmisión terminada por inactividad (15s)');
        stopTransmit(false);
      }, MAX_LOCAL_SPEAK);
    }
    
    requestAnimationFrame(checkVADLevel);
  }
  
  function stopVAD() {
    isCheckingVad = false;
  }

  // ============ PTT LOGIC (Real Audio) ============
  function setupPTT() {
    const btn = document.getElementById('pttBtn');

    // Mouse events
    btn.addEventListener('mousedown', startTransmit);
    btn.addEventListener('mouseup', stopTransmit);
    btn.addEventListener('mouseleave', stopTransmit);

    // Touch events
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); startTransmit(); });
    btn.addEventListener('touchend', (e) => { e.preventDefault(); stopTransmit(); });
    btn.addEventListener('touchcancel', stopTransmit);

    // Keyboard (spacebar)
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); startTransmit(); }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { e.preventDefault(); stopTransmit(); }
    });
  }

  async function startTransmit() {
    if (isTransmitting) return;
    if (!currentChannel && !currentPrivateUser) {
      showToast('⚠️ Debes conectarte a un canal primero');
      return;
    }
    
    if (!micStream) {
      showToast('⚠️ Permiso de micrófono requerido');
      requestMicrophone();
      return;
    }

    isTransmitting = true;
    speakGranted = false;

    const btn = document.getElementById('pttBtn');
    btn.classList.add('transmitting');
    document.getElementById('pttLabel').textContent = 'TRANSMITIENDO';
    document.getElementById('pttHint').textContent = 'Suelta para terminar';
    showSpeaker('TÚ', '🎙️', true);
    if (navigator.vibrate) navigator.vibrate(50);

    // Solicitar turno al servidor EN PARALELO (no bloquear)
    const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
    if (socket && currentRoom) {
      socket.emit('REQUEST_TO_SPEAK', {
        room: currentRoom,
        userName: loggedInUser.nombre || 'Piloto',
        userRole: loggedInUser.rol || 'piloto'
      });
    }

    // Timeout de seguridad (solo si NO es modo Micrófono Abierto)
    if (!isHandsFreeMode) {
      clearTimeout(transmitTimeout);
      transmitTimeout = setTimeout(() => {
        showToast('⏱️ Transmisión terminada por inactividad (15s)');
        stopTransmit(false);
      }, MAX_LOCAL_SPEAK);
      startVAD();
    }

    const sender = {
      name: loggedInUser.nombre || 'Piloto',
      initials: (loggedInUser.nombre || 'P').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()
    };

    // ═══ WebRTC (Mediasoup) — Audio directo por UDP ═══
    if (useWebRTC && radioMedia) {
      const ok = await radioMedia.startProducing(micStream, sender);
      if (ok) {
        console.log('[PTT] Transmitiendo vía WebRTC (UDP/OPUS)');
      } else {
        console.warn('[PTT] WebRTC falló, usando fallback Socket.io');
        startFallbackRecording(sender);
      }
      return;
    }

    // ═══ FALLBACK: Socket.io (TCP) — Ciclos de grabación ═══
    startFallbackRecording(sender);
  }

  // Fallback: Grabar en ciclos y enviar por Socket.io (cuando no hay Mediasoup)
  function startFallbackRecording(sender) {
    const CYCLE_MS = 1000;
    function recordCycle() {
      if (!isTransmitting || !micStream) return;
      try {
        mediaRecorder = new MediaRecorder(micStream);
        const chunks = [];
        const mimeType = mediaRecorder.mimeType || 'audio/webm';
        mediaRecorder.ondataavailable = event => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        mediaRecorder.onstop = () => {
          if (chunks.length > 0 && socket && currentRoom) {
            const audioBlob = new Blob(chunks, { type: mimeType });
            socket.emit('transmit_voice', { room: currentRoom, audioBlob, mimeType, sender });
          }
          if (isTransmitting) setTimeout(recordCycle, 20);
        };
        mediaRecorder.start();
        setTimeout(() => {
          if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        }, CYCLE_MS);
      } catch (e) {
        console.warn('Error starting MediaRecorder cycle:', e);
      }
    }
    recordCycle();
    console.log('[PTT] Fallback: Grabando en ciclos de 1s vía Socket.io');
  }

  function stopTransmit(abort) {
    if (!isTransmitting && !abort) return;
    isTransmitting = false;
    speakGranted = false;
    clearTimeout(transmitTimeout);
    stopVAD();

    const btn = document.getElementById('pttBtn');
    btn.classList.remove('transmitting');
    document.getElementById('pttLabel').textContent = 'HABLAR';
    document.getElementById('pttHint').textContent = 'Mantener presionado para hablar';

    hideSpeaker();

    // ═══ Detener WebRTC Producer ═══
    if (useWebRTC && radioMedia) {
      radioMedia.stopProducing();
    }

    // ═══ Detener Fallback MediaRecorder ═══
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      if (abort) mediaRecorder.onstop = null;
      mediaRecorder.stop();
    }

    // Liberar turno en el servidor
    if (socket && currentRoom) {
      socket.emit('RELEASE_SPEAK', { room: currentRoom });
    }

    if (navigator.vibrate) navigator.vibrate(30);
    
    // Si Micrófono Abierto sigue activo, reiniciar transmisión automáticamente
    if (isHandsFreeMode && !abort) {
      setTimeout(() => {
        if (isHandsFreeMode) startTransmit();
      }, 100);
    }
  }


  // ============ SPEAKER DISPLAY ============
  function showSpeaker(name, initials, isSelf) {
    document.getElementById('idleStatus').style.display = 'none';
    const info = document.getElementById('speakerInfo');
    info.classList.add('active');
    document.getElementById('speakerName').textContent = name;
    document.getElementById('speakerInitial').textContent = initials;
    const avatar = document.getElementById('speakerAvatar');
    if (isSelf) {
      avatar.style.background = 'linear-gradient(135deg, var(--green), #00b060)';
      avatar.classList.add('is-self');
    } else {
      avatar.style.background = 'linear-gradient(135deg, var(--accent), #0080ff)';
      avatar.classList.remove('is-self');
    }
  }

  function hideSpeaker() {
    document.getElementById('speakerInfo').classList.remove('active');
    setTimeout(() => {
      if (!document.getElementById('speakerInfo').classList.contains('active')) {
        document.getElementById('idleStatus').style.display = '';
      }
    }, 350);
  }

  // ============ AUDIO FEEDBACK (REMOVED: Old Beeps) ============
  function playTone(freq, duration) {
    // Las transmisiones de voz reales reemplazan a estos beeps.
  }

  // ============ MODALS ============
  function setupModals() {
    // Channel modal
    const channelModal = document.getElementById('channelModal');
    document.getElementById('btnChannels').addEventListener('click', () => {
      renderChannels();
      channelModal.classList.add('active');
    });
    // Cerrar solo al tocar el overlay (fondo oscuro), NO al tocar el contenido
    channelModal.addEventListener('click', (e) => {
      if (e.target === channelModal) channelModal.classList.remove('active');
    });

    // Private modal
    const privateModal = document.getElementById('privateModal');
    document.getElementById('btnPrivate').addEventListener('click', () => {
      renderUsers();
      privateModal.classList.add('active');
    });
    privateModal.addEventListener('click', (e) => {
      if (e.target === privateModal) privateModal.classList.remove('active');
    });
    privateModal.querySelector('.modal-content').addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Logout
    const btnLogout = document.getElementById('btnLogout');
    if (btnLogout) {
      btnLogout.addEventListener('click', () => {
        sessionStorage.removeItem('cel_auth');
        sessionStorage.removeItem('cel_user');
        sessionStorage.removeItem('cel_empresa');
        window.location.href = 'index.html';
      });
    }
  }

  function renderChannels() {
    const list = document.getElementById('channelList');
    list.innerHTML = '';
    
    if (channels.length === 0) {
      list.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: #64748b;"><div style="font-size:48px; margin-bottom:16px;">📡</div><h3 style="color:#fff;">Sin Canales</h3><p>No hay canales configurados.</p></div>';
      return;
    }
    
    channels.forEach(ch => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'channel-item' + ((currentChannel && ch.id === currentChannel.id) ? ' active' : '');
      btn.style.cssText = 'display:flex; align-items:center; gap:14px; padding:14px 16px; border-radius:12px; cursor:pointer; width:100%; border:1px solid rgba(255,255,255,0.06); background:rgba(30,36,50,0.6); color:#fff; font-family:inherit; margin-bottom:8px; text-align:left;';
      if (currentChannel && ch.id === currentChannel.id) {
        btn.style.background = 'rgba(0,212,255,0.15)';
        btn.style.borderColor = 'rgba(0,212,255,0.4)';
      }
      btn.innerHTML = `<div style="width:42px;height:42px;border-radius:12px;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">${ch.icon}</div><div><div style="font-weight:600;font-size:15px;">${ch.name}</div><div style="font-size:12px;color:#94a3b8;">${ch.users} conectados</div></div>`;
      
      btn.addEventListener('click', function() {
        currentChannel = ch;
        currentPrivateUser = null;
        updateChannelDisplay();
        document.getElementById('channelModal').classList.remove('active');
        showToast('📻 Conectado a Canal: ' + ch.name);
      });
      
      list.appendChild(btn);
    });
  }

  function renderUsers() {
    const container = document.getElementById('userList');
    container.innerHTML = '';
    const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
    const otherUsers = users.filter(u => u.id !== loggedInUser.id);
    // Ordenar: online primero, offline después
    otherUsers.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));

    if (otherUsers.length === 0) {
      container.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: #64748b;"><div style="font-size:48px; margin-bottom:16px;">👤</div><h3 style="color:#fff;">Sin Usuarios</h3><p>No hay otros usuarios registrados.</p></div>';
      return;
    }
    
    otherUsers.forEach(u => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = 'display:flex; align-items:center; gap:12px; padding:14px 16px; border-radius:12px; cursor:pointer; width:100%; border:1px solid rgba(255,255,255,0.06); background:rgba(30,36,50,0.6); color:#fff; font-family:inherit; margin-bottom:8px; text-align:left; opacity:' + (u.online ? '1' : '0.5') + ';';
      
      const dotColor = u.online ? '#10b981' : '#64748b';
      const statusText = u.online ? 'En línea' : 'Desconectado';
      
      btn.innerHTML = `
        <div style="width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg, #0ea5e9, #6366f1);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;">${u.initials}</div>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:15px;">${u.name}</div>
          <div style="font-size:12px;color:#94a3b8;">${u.role}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
          <div style="width:12px;height:12px;border-radius:50%;background:${dotColor};box-shadow:0 0 6px ${dotColor};"></div>
          <span style="font-size:9px;color:${dotColor};">${statusText}</span>
        </div>
      `;
      
      btn.addEventListener('click', function() {
        if (!u.online) {
          showToast('⚠️ ' + u.name + ' está desconectado');
          return;
        }
        currentPrivateUser = u;
        currentChannel = null;
        updateChannelDisplay();
        
        if (socket) {
          const tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
          const roomName = 'private_' + tenant.id + '_' + Math.min(loggedInUser.id, u.id) + '_' + Math.max(loggedInUser.id, u.id);
          
          socket.emit('force_private_call', {
            targetUserId: u.id,
            empresaId: tenant.id,
            roomName: roomName,
            caller: {
              id: loggedInUser.id,
              nombre: loggedInUser.nombre || 'Piloto',
              initials: (loggedInUser.nombre || 'P').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()
            }
          });
        }
        
        document.getElementById('privateModal').classList.remove('active');
        showToast('📞 Llamada Privada con: ' + u.name);
      });
      
      container.appendChild(btn);
    });
  }

  // ============ EMERGENCY ============
  function setupEmergency() {
    const emergencyModal = document.getElementById('emergencyModal');
    const confirmBtn = document.getElementById('confirmEmergency');
    let holdTimer = null;

    document.getElementById('btnEmergency').addEventListener('click', () => {
      emergencyModal.classList.add('active');
    });

    confirmBtn.addEventListener('mousedown', () => {
      confirmBtn.textContent = '🚨 MANTENIENDO...';
      holdTimer = setTimeout(() => {
        emergencyModal.classList.remove('active');
        showToast('🚨 ¡EMERGENCIA ENVIADA!');
        if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
      }, 3000);
    });

    confirmBtn.addEventListener('mouseup', () => {
      clearTimeout(holdTimer);
      confirmBtn.textContent = '🚨 MANTENER PARA CONFIRMAR';
    });

    confirmBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      confirmBtn.textContent = '🚨 MANTENIENDO...';
      holdTimer = setTimeout(() => {
        emergencyModal.classList.remove('active');
        showToast('🚨 ¡EMERGENCIA ENVIADA!');
        if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
      }, 3000);
    });

    confirmBtn.addEventListener('touchend', () => {
      clearTimeout(holdTimer);
      confirmBtn.textContent = '🚨 MANTENER PARA CONFIRMAR';
    });

    document.getElementById('cancelEmergency').addEventListener('click', () => {
      emergencyModal.classList.remove('active');
    });

    emergencyModal.addEventListener('click', (e) => {
      if (e.target === emergencyModal) emergencyModal.classList.remove('active');
    });
  }

  // ============ TOAST ============
  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }

  // ═══ INIT WEBRTC ═══
  async function initWebRTC() {
    if (!window.RadioMediaClient) {
      console.log('[WebRTC] mediasoup-client no disponible, usando fallback Socket.io');
      return;
    }
    radioMedia = new window.RadioMediaClient();
    const ok = await radioMedia.init(socket);
    if (ok) {
      useWebRTC = true;
      console.log('[WebRTC] ✅ Mediasoup SFU ACTIVO — Audio por WebRTC (UDP)');
      // Registrar callbacks para UI
      radioMedia.onNewSpeaker((name, initials) => {
        if (!isTransmitting) showSpeaker(name, initials || name.slice(0,2).toUpperCase(), false);
      });
      radioMedia.onSpeakerStop((name) => {
        if (!isTransmitting) hideSpeaker();
      });
    } else {
      console.log('[WebRTC] No se pudo inicializar, usando fallback Socket.io');
    }
  }

  // ============ BOOT ============
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
