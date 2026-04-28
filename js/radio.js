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

  // ============ INIT ============
  function init() {
    loadTenantInfo();
    updateChannelDisplay();
    setupPTT();
    setupModals();
    setupEmergency();
    setupHandsFree();
    requestMicrophone();
    setupSocketReceivers();
    
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
    
    // Conteo de usuarios en el canal
    socket.on('channel_user_count', (data) => {
      if (currentChannel && data.room && data.room.includes(`canal_${currentChannel.id}`)) {
        currentChannel.users = data.count;
        const countEl = document.getElementById('userCount');
        if (countEl) countEl.textContent = data.count;
      }
    });
    
    // ── Recibir audio y reproducir inmediatamente ──
    let speakerTimeout = null;
    socket.on('receive_voice', async (data) => {
      const { audioBlob, sender, mimeType } = data;
      if (!audioBlob) return;
      showSpeaker(sender.name, sender.initials, false);
      
      // Safety timeout: ocultar speaker después de 10s máx
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
        source.onended = () => { clearTimeout(speakerTimeout); hideSpeaker(); };
        source.start(0);
      } catch (err) {
        console.warn('AudioContext decode failed, trying <audio> fallback:', err);
        // Fallback: usar el elemento <audio> persistente
        try {
          const blob = new Blob([audioBlob], { type: mimeType || 'audio/webm' });
          const url = URL.createObjectURL(blob);
          const liveAudio = document.getElementById('liveAudio');
          if (liveAudio) {
            liveAudio.src = url;
            liveAudio.onended = () => { clearTimeout(speakerTimeout); hideSpeaker(); URL.revokeObjectURL(url); };
            liveAudio.onerror = () => { clearTimeout(speakerTimeout); hideSpeaker(); URL.revokeObjectURL(url); };
            await liveAudio.play();
          }
        } catch (fallbackErr) {
          console.warn('Audio fallback also failed:', fallbackErr);
          hideSpeaker();
        }
      }
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
      // Nombres apilados: uno arriba, otro abajo
      nameEl.innerHTML = `<div class="private-names">
        <div class="caller-name">${myName}</div>
        <div class="divider-icon">📞 ↕️</div>
        <div class="callee-name">${currentPrivateUser.name}</div>
      </div>`;
      usersEl.textContent = 'Comunicación privada enlazada';
      idleIcon.textContent = '📞';
      idleText.textContent = 'Línea privada — listo para hablar';
      
      if (socket) {
        let tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
        const roomName = `private_${tenant.id}_${Math.min(loggedInUser.id, currentPrivateUser.id)}_${Math.max(loggedInUser.id, currentPrivateUser.id)}`;
        currentRoom = roomName;
        socket.emit('join_channel', { channelId: roomName, empresaId: tenant.id, userName: loggedInUser.nombre, tipo: 'privado' });
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
      }
    }
  }

  // Hands-free voice recognition state
  let recognition = null;
  let isListening = false;
  let handsFreeTimer = null;

  // ============ HANDS-FREE MODE (Wake Word: "Atento, Atento [Canal]") ============
  function setupHandsFree() {
    const btn = document.getElementById('btnHandsFree');
    if (!btn) return;
    
    btn.addEventListener('click', () => {
      if (!currentChannel && !currentPrivateUser) {
        showToast('⚠️ Conéctate a un canal primero');
        return;
      }
      
      isHandsFreeMode = !isHandsFreeMode;
      btn.classList.toggle('active', isHandsFreeMode);
      
      if (isHandsFreeMode) {
        // ABRIR MICRÓFONO INMEDIATAMENTE
        showToast('🎙️ Micrófono Abierto — TRANSMITIENDO');
        document.getElementById('voiceIndicator').style.display = 'block';
        document.getElementById('voiceIndicator').textContent = '🟢 Micrófono Abierto — Transmitiendo en vivo';
        
        // Iniciar transmisión directa (misma lógica que PTT)
        startTransmit();
      } else {
        // CERRAR MICRÓFONO
        showToast('🔇 Micrófono Abierto DESACTIVADO');
        document.getElementById('voiceIndicator').style.display = 'none';
        
        // Detener transmisión
        stopTransmit(false);
      }
    });
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

  function startTransmit() {
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
      
      // Iniciar el monitoreo de audio para resetear el timer mientras haya voz
      startVAD();
    }
    
    // GRABAR INMEDIATAMENTE (sin esperar respuesta del servidor)
    const sender = {
      name: loggedInUser.nombre || 'Piloto',
      initials: (loggedInUser.nombre || 'P').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()
    };
    
    try {
      mediaRecorder = new MediaRecorder(micStream);
      const chunks = [];
      
      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      
      mediaRecorder.onstop = () => {
        if (chunks.length > 0 && socket && currentRoom) {
          const mimeType = mediaRecorder.mimeType || 'audio/webm';
          const audioBlob = new Blob(chunks, { type: mimeType });
          console.log('[PTT] Enviando blob completo:', audioBlob.size, 'bytes');
          socket.emit('transmit_voice', { room: currentRoom, audioBlob, mimeType, sender });
        }
      };
      
      mediaRecorder.start();
      console.log('[PTT] Grabando audio completo');
    } catch (e) {
      console.warn('Error starting MediaRecorder:', e);
    }
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

    // Resetear botón de Micrófono Abierto si estaba activo
    if (isHandsFreeMode) {
      isHandsFreeMode = false;
      const hfBtn = document.getElementById('btnHandsFree');
      if (hfBtn) hfBtn.classList.remove('active');
      document.getElementById('voiceIndicator').style.display = 'none';
    }

    if (mediaRecorder && mediaRecorder.state === 'recording') {
      if (abort) mediaRecorder.onstop = null;
      mediaRecorder.stop();
    }

    // Liberar turno en el servidor
    if (socket && currentRoom) {
      socket.emit('RELEASE_SPEAK', { room: currentRoom });
    }

    if (navigator.vibrate) navigator.vibrate(30);
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

  // ============ BOOT ============
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init(); // Si el DOM ya cargó mientras se hacían los fetch(), ejecutar init() directamente
  }
})();
