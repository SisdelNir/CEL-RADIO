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
      usersEl.innerHTML = `👥 <span id="userCount">${currentChannel.users}</span> conectados`;
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

  // ============ HANDS-FREE MODE (Continuous Streaming) ============
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
        showToast('🎙️ Manos Libres ACTIVADO — micrófono abierto');
        document.getElementById('voiceIndicator').style.display = 'block';
        document.getElementById('voiceIndicator').textContent = '🎙️ Manos Libres activo — micrófono abierto';
        startHandsFreeStream();
      } else {
        showToast('🔇 Manos Libres DESACTIVADO');
        document.getElementById('voiceIndicator').style.display = 'none';
        stopHandsFreeStream();
      }
    });
  }
  
  function startHandsFreeStream() {
    if (!micStream || !socket || !currentRoom) return;
    const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
    const sender = {
      name: loggedInUser.nombre || 'Piloto',
      initials: (loggedInUser.nombre || 'P').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()
    };
    
    function recordCycle() {
      if (!isHandsFreeMode || !micStream) return;
      try {
      const mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm;codecs=opus';
        handsFreeRecorder = new MediaRecorder(micStream, { mimeType });
        const chunks = [];
        
        handsFreeRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        handsFreeRecorder.onstop = () => {
          if (chunks.length > 0 && socket && currentRoom) {
            const blob = new Blob(chunks, { type: mimeType });
            socket.emit('transmit_voice', { room: currentRoom, audioBlob: blob, mimeType, sender });
          }
          // Iniciar siguiente ciclo
          if (isHandsFreeMode) setTimeout(recordCycle, 50);
        };
        handsFreeRecorder.start();
        // Detener después de 2 segundos para enviar audio completo y decodificable
        setTimeout(() => {
          if (handsFreeRecorder && handsFreeRecorder.state === 'recording') handsFreeRecorder.stop();
        }, 2000);
      } catch (e) {
        console.warn('HandsFree recorder error:', e);
      }
    }
    recordCycle();
  }
  
  function stopHandsFreeStream() {
    if (handsFreeRecorder && handsFreeRecorder.state === 'recording') {
      handsFreeRecorder.stop();
    }
    handsFreeRecorder = null;
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

    const btn = document.getElementById('pttBtn');
    btn.classList.add('active');
    document.getElementById('pttLabel').textContent = 'TRANSMITIENDO';
    document.getElementById('pttHint').textContent = 'Suelta para terminar';

    showSpeaker('TÚ', '🎙️', true);
    if (navigator.vibrate) navigator.vibrate(50);

    const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
    
    // ── Iniciar MediaRecorder — Blob completo al soltar (compatible con todos los navegadores) ──
    try {
      const mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm;codecs=opus';
      mediaRecorder = new MediaRecorder(micStream, { mimeType });
      const chunks = [];
      const sender = {
        name: loggedInUser.nombre || 'Piloto',
        initials: (loggedInUser.nombre || 'P').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()
      };
      
      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      
      mediaRecorder.onstop = () => {
        if (chunks.length > 0 && socket && currentRoom) {
          const audioBlob = new Blob(chunks, { type: mimeType });
          console.log(`[PTT] Enviando audio: ${audioBlob.size} bytes, tipo: ${mimeType}, sala: ${currentRoom}`);
          socket.emit('transmit_voice', { room: currentRoom, audioBlob, mimeType, sender });
        } else {
          console.warn('[PTT] No se envió audio:', { chunks: chunks.length, socket: !!socket, room: currentRoom });
        }
      };
      
      mediaRecorder.start(); // Sin timeslice = blob completo al detener
      console.log(`[PTT] Grabando con: ${mimeType}`);
    } catch (e) {
      console.warn("Error starting MediaRecorder:", e);
    }
  }

  function stopTransmit(abort) {
    if (!isTransmitting && !abort) return;
    isTransmitting = false;

    const btn = document.getElementById('pttBtn');
    btn.classList.remove('active');
    document.getElementById('pttLabel').textContent = 'HABLAR';
    document.getElementById('pttHint').textContent = 'Mantener presionado para hablar';

    hideSpeaker();

    if (mediaRecorder && mediaRecorder.state === 'recording') {
      if (abort) mediaRecorder.onstop = null;
      mediaRecorder.stop();
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
    if (isSelf) {
      document.getElementById('speakerAvatar').style.background = 'linear-gradient(135deg, var(--green), #00b060)';
    } else {
      document.getElementById('speakerAvatar').style.background = 'linear-gradient(135deg, var(--accent), #0080ff)';
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
    if (channels.length === 0) {
      list.innerHTML = `
        <div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">
          <div style="font-size: 48px; margin-bottom: 16px; opacity: 0.5;">📡</div>
          <h3 style="color: #fff; margin-bottom: 8px;">Sin Canales</h3>
          <p>No hay canales configurados para tu empresa.</p>
        </div>
      `;
    } else {
      list.innerHTML = channels.map(ch => `
        <li class="channel-item ${(currentChannel && ch.id === currentChannel.id) ? 'active' : ''}" data-id="${ch.id}">
          <div class="ch-icon">${ch.icon}</div>
          <div>
            <div class="ch-name">${ch.name}</div>
            <div class="ch-users">${ch.users} conectados</div>
          </div>
        </li>
      `).join('');
    }

    list.querySelectorAll('.channel-item').forEach(item => {
      item.addEventListener('click', () => {
        const ch = channels.find(x => String(x.id) === item.dataset.id);
        if (ch) {
          currentChannel = ch;
          currentPrivateUser = null;
          updateChannelDisplay();
          document.getElementById('channelModal').classList.remove('active');
          showToast(`Conectado a Canal: ${ch.name}`);
        }
      });
    });
  }

  function renderUsers() {
    const container = document.getElementById('userList');
    // Filtrar al propio usuario y solo mostrar a los que están "Visible" (online = true)
    const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
    const otherUsers = users.filter(u => u.id !== loggedInUser.id && u.online);

    if (otherUsers.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">
          <div style="font-size: 48px; margin-bottom: 16px; opacity: 0.5;">👤</div>
          <h3 style="color: #fff; margin-bottom: 8px;">Nadie Disponible</h3>
          <p>No hay otros usuarios visibles o en turno en este momento.</p>
        </div>
      `;
    } else {
      container.innerHTML = otherUsers.map(u => `
        <div class="user-item" data-id="${u.id}">
          <div class="user-avatar">${u.initials}</div>
          <div>
            <div class="user-name">${u.name}</div>
            <div class="user-role">${u.role}</div>
          </div>
          <div class="user-status-dot online"></div>
        </div>
      `).join('');
    }

    container.querySelectorAll('.user-item').forEach(item => {
      item.addEventListener('click', () => {
        const u = users.find(x => String(x.id) === item.dataset.id);
        if (u && u.online) {
          currentPrivateUser = u;
          currentChannel = null;
          updateChannelDisplay();
          
          // Emitir orden de Jalón Automático
          if (socket) {
            const tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
            const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
            const roomName = `private_${tenant.id}_${Math.min(loggedInUser.id, u.id)}_${Math.max(loggedInUser.id, u.id)}`;
            
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
          showToast(`Llamada Privada iniciada con: ${u.name}`);
        } else if (u && !u.online) {
          showToast('Usuario no disponible');
        }
      });
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
