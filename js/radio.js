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
  let audioChunks = [];
  let currentRoom = null;
  let micStream = null;
  
  let isChannelLocked = false;
  let lockedByUser = '';
  let isHandsFreeMode = false;

  // Speech Recognition state
  let recognition = null;
  let isListening = false;
  let handsFreeTimer = null;

  // ============ INIT ============
  function init() {
    loadTenantInfo();
    updateChannelDisplay();
    setupPTT();
    setupModals();
    setupEmergency();
    setupSocketReceivers();
    setupActivation();
  }

  // ============ ACTIVATION OVERLAY ============
  function setupActivation() {
    const overlay = document.getElementById('activationOverlay');
    const toggle = document.getElementById('micToggle');
    const enterBtn = document.getElementById('btnEnterRadio');
    const statusText = document.getElementById('activationStatus');
    
    if (!overlay || !toggle || !enterBtn) return;
    
    // When the user flips the toggle → request microphone
    toggle.addEventListener('change', async () => {
      if (toggle.checked) {
        statusText.innerHTML = '⏳ Activando micrófono...';
        
        unlockAudioContext();
        
        const micPromise = navigator.mediaDevices.getUserMedia({ 
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
        });
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('timeout')), 3000)
        );
        
        try {
          micStream = await Promise.race([micPromise, timeoutPromise]);
          statusText.innerHTML = '<span style="color:#10b981">✅ Micrófono activado — Presiona ENTRAR</span>';
        } catch (err) {
          console.warn('Mic issue:', err);
          statusText.innerHTML = '<span style="color:#fbbf24">⚠️ Micrófono pendiente — Puedes entrar</span>';
        }
      } else {
        if (micStream) {
          micStream.getTracks().forEach(t => t.stop());
          micStream = null;
        }
        statusText.innerHTML = 'Activa el micrófono para continuar';
      }
    });
    
    // Enter button → go to the radio
    enterBtn.addEventListener('click', () => {
      unlockAudioContext();
      overlay.classList.add('hidden');
    });
  }

  async function requestMicrophone() {
    if (micStream) return; // Already have it
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ 
        audio: { 
          echoCancellation: true, 
          noiseSuppression: true,
          autoGainControl: true 
        } 
      });
    } catch (err) {
      console.warn("Microphone access denied or error:", err);
      micStream = null;
    }
  }

  function setupSocketReceivers() {
    if (!socket) return;
    
    // Registrar usuario en su frecuencia personal
    const tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
    const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
    if (tenant.id && loggedInUser.id) {
      socket.emit('register_user', { empresaId: tenant.id, userId: loggedInUser.id, userName: loggedInUser.nombre });
    }
    
    // Escuchar cambio de estado (Visible/Oculto) de otros usuarios
    socket.on('user_status_changed', (data) => {
      const { userId, isOnline } = data;
      const u = users.find(x => x.id === userId);
      if (u) {
        u.online = isOnline;
        // Si el modal de privados está abierto, refrescarlo
        if (document.getElementById('privateModal').classList.contains('active')) {
          renderUsers();
        }
      }
    });
    
    // Escuchar "jalón" automático a llamada privada
    socket.on('incoming_private_call', (data) => {
      const { roomName, caller } = data;
      // Actualizar variables de estado
      currentChannel = null;
      currentPrivateUser = { id: caller.id, name: caller.nombre, initials: caller.initials };
      
      // Cerrar modales si están abiertos
      document.getElementById('channelModal').classList.remove('active');
      document.getElementById('privateModal').classList.remove('active');
      
      // Forzar cambio visual y conexión
      updateChannelDisplay();
      showToast(`📞 Llamada entrante de ${caller.nombre}`);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    });
    
    // Escuchar Half-Duplex
    socket.on('channel_locked', (data) => {
      isChannelLocked = true;
      lockedByUser = data.user;
      
      // Mostrar quién habla en el área del speaker
      const initials = (data.user || 'P').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
      showSpeaker(data.user, initials, false);
      
      const btn = document.getElementById('pttBtn');
      if (btn) {
        btn.style.background = 'linear-gradient(145deg, #3a1111, #2a0a0a)';
        btn.style.borderColor = '#ff4444';
        const label = document.getElementById('pttLabel');
        const hint = document.getElementById('pttHint');
        if (label) { label.textContent = 'OCUPADO'; label.style.color = '#ff4444'; }
        if (hint) { hint.innerHTML = `<span style="color:#ff4444;font-size:13px">⚠️ ${lockedByUser.toUpperCase()} HABLANDO</span>`; }
      }
    });

    socket.on('channel_unlocked', () => {
      isChannelLocked = false;
      lockedByUser = '';
      
      hideSpeaker();
      
      const btn = document.getElementById('pttBtn');
      if (btn) {
        btn.style.background = '';
        btn.style.borderColor = '';
        const label = document.getElementById('pttLabel');
        const hint = document.getElementById('pttHint');
        if (label) { label.textContent = 'HABLAR'; label.style.color = ''; }
        if (hint) { hint.textContent = 'Mantener presionado para hablar'; }
      }
    });
    
    // Tracking de usuarios en el canal
    socket.on('room_user_count', (data) => {
      const countEl = document.getElementById('userCountNum');
      if (countEl) countEl.textContent = data.count;
    });
    
    // Lista de usuarios en el canal (respuesta)
    socket.on('channel_users_list', (data) => {
      const list = document.getElementById('channelUsersList');
      const modal = document.getElementById('channelUsersModal');
      if (list && modal) {
        if (data.users.length === 0) {
          list.innerHTML = '<li style="color:#94a3b8;justify-content:center;">No hay usuarios conectados</li>';
        } else {
          list.innerHTML = data.users.map(name => `
            <li><div class="user-dot"></div>${name}</li>
          `).join('');
        }
        modal.classList.add('active');
      }
    });
    
    socket.on('receive_voice', async (data) => {
      const { audioBlob, sender, mimeType } = data;
      if (!audioBlob) return;

      showSpeaker(sender.name, sender.initials, false);

      try {
        const blob = new Blob([audioBlob], { type: mimeType || 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        
        audio.onended = () => {
          hideSpeaker();
          URL.revokeObjectURL(url);
        };
        audio.onerror = () => {
          console.warn("Audio element failed, trying AudioContext fallback");
          hideSpeaker();
          URL.revokeObjectURL(url);
        };
        
        await audio.play();
      } catch (err) {
        console.warn("Audio playback error:", err);
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
      stopVoiceRecognition();
    } else if (currentPrivateUser) {
      const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
      const myName = loggedInUser.nombre || 'TÚ';

      labelEl.textContent = '📞 Llamada Privada';
      nameEl.textContent = `${myName} (Anfitrión) y ${currentPrivateUser.name}`;
      usersEl.textContent = 'Comunicación privada enlazada';
      idleIcon.textContent = '📞';
      idleText.textContent = 'Línea privada — listo para hablar';
      if (isHandsFreeMode) startVoiceRecognition();
      
      if (socket) {
        let tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
        const roomName = `private_${tenant.id}_${Math.min(loggedInUser.id, currentPrivateUser.id)}_${Math.max(loggedInUser.id, currentPrivateUser.id)}`;
        currentRoom = roomName;
        socket.emit('join_channel', { channelId: roomName, empresaId: tenant.id, userName: loggedInUser.nombre, tipo: 'privado' });
      }
    } else {
      labelEl.textContent = 'Canal Activo';
      nameEl.textContent = `📻 ${currentChannel.name}`;
      usersEl.innerHTML = `<span id="userCount" style="cursor:pointer;text-decoration:underline;color:var(--accent)" onclick="document.dispatchEvent(new CustomEvent('show_channel_users'))">👥 <span id="userCountNum">${currentChannel.users}</span> conectados — Ver</span>`;
      idleIcon.textContent = currentChannel.icon || '📻';
      idleText.textContent = 'Canal libre — listo para hablar';
      if (isHandsFreeMode) startVoiceRecognition();
      
      if (socket) {
        let tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
        const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
        currentRoom = `empresa_${tenant.id}_canal_${currentChannel.id}`;
        socket.emit('join_channel', { channelId: currentChannel.id, empresaId: tenant.id, userName: loggedInUser.nombre, tipo: 'grupo' });
      }
    }
  }

  // ============ HANDS-FREE VOICE RECOGNITION ============
  function startVoiceRecognition() {
    if (isListening || !('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) return;
    
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'es-ES';

    recognition.onstart = function() {
      isListening = true;
      document.getElementById('voiceIndicator').style.display = 'block';
    };

    recognition.onresult = function(event) {
      if (isTransmitting) return; // Ya estamos hablando
      
      const transcript = event.results[event.results.length - 1][0].transcript.toLowerCase();
      
      // Buscar frase "atento atento" (ignorando comas u otros signos)
      if (transcript.includes('atento atento') || transcript.includes('atento, atento')) {
        // ACTIVAR MICRÓFONO
        startTransmit();
        showToast('🎙️ Transmisión manos libres activada');
        
        // Cerrar después de 15 segundos
        clearTimeout(handsFreeTimer);
        handsFreeTimer = setTimeout(() => {
          if (isTransmitting) {
            stopTransmit();
            showToast('🛑 Transmisión manos libres terminada');
          }
        }, 15000);
      }
    };

    recognition.onerror = function(event) {
      console.error('Speech recognition error', event.error);
    };

    recognition.onend = function() {
      isListening = false;
      document.getElementById('voiceIndicator').style.display = 'none';
      
      // Solo reiniciar si el Modo Manos Libres está activado
      if (isHandsFreeMode && (currentChannel || currentPrivateUser)) {
        try { recognition.start(); } catch(e) {}
      }
    };

    try {
      recognition.start();
    } catch (e) {
      console.error(e);
    }
  }

  function stopVoiceRecognition() {
    if (recognition) {
      recognition.stop();
      isListening = false;
      document.getElementById('voiceIndicator').style.display = 'none';
    }
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

    // Unlock audio context on first interaction (iOS fix)
    document.body.addEventListener('touchstart', unlockAudioContext, { once: true });
    document.body.addEventListener('click', unlockAudioContext, { once: true });
  }

  async function startTransmit() {
    if (isTransmitting) return;
    
    unlockAudioContext();

    if (!currentChannel && !currentPrivateUser) {
      showToast('⚠️ Debes conectarte a un canal primero');
      return;
    }
    
    // Request mic on first PTT press (user gesture = most compatible)
    if (!micStream) {
      showToast('🎤 Permitir micrófono para hablar...');
      await requestMicrophone();
      if (!micStream) {
        showToast('❌ Sin micrófono. Abre en Safari/Chrome y permite el micrófono.');
        return;
      }
      showToast('✅ Micrófono listo. ¡Presiona de nuevo para hablar!');
      return; // Let user press again now that mic is ready
    }

    if (isChannelLocked) {
      showToast(`⚠️ ESPERA QUE ${lockedByUser.toUpperCase()} TERMINE`);
      if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
      return;
    }

    isTransmitting = true;

    const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
    if (socket && currentRoom) {
      socket.emit('lock_channel', { room: currentRoom, user: loggedInUser.nombre || 'Piloto' });
    }

    const btn = document.getElementById('pttBtn');
    btn.classList.add('active');
    document.getElementById('pttLabel').textContent = 'TRANSMITIENDO';
    document.getElementById('pttHint').textContent = 'Suelta para terminar';

    // Show self as speaker
    showSpeaker('TÚ', '🎙️', true);

    // Vibrate feedback
    if (navigator.vibrate) navigator.vibrate(50);
    
    // Start MediaRecorder
    try {
      audioChunks = [];
      
      const options = { mimeType: 'audio/webm;codecs=opus' };
      if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(options.mimeType)) {
        mediaRecorder = new MediaRecorder(micStream, options);
      } else {
        // Fallback for iOS Safari
        mediaRecorder = new MediaRecorder(micStream);
      }
      
      mediaRecorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };
      
      mediaRecorder.onstop = () => {
        if (audioChunks.length > 0 && socket && currentRoom) {
          const mimeType = mediaRecorder.mimeType || 'audio/webm';
          const audioBlob = new Blob(audioChunks, { type: mimeType });
          const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
          
          socket.emit('transmit_voice', {
            room: currentRoom,
            audioBlob: audioBlob,
            mimeType: mimeType,
            sender: {
              name: loggedInUser.nombre || 'Piloto',
              initials: (loggedInUser.nombre || 'P').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()
            }
          });
        } else {
           console.warn("No audio chunks recorded or missing socket/room");
        }
      };
      
      // Pasar un timeslice (ej. 250ms) obliga a Safari a emitir chunks periódicamente
      // resolviendo un bug donde ondataavailable nunca se dispara si la grabación es corta.
      mediaRecorder.start(250);
    } catch (e) {
      console.warn("Error starting MediaRecorder:", e);
    }
  }

  function stopTransmit() {
    if (!isTransmitting) return;
    isTransmitting = false;
    
    if (socket && currentRoom) {
      socket.emit('unlock_channel', { room: currentRoom });
    }

    clearTimeout(handsFreeTimer);

    const btn = document.getElementById('pttBtn');
    btn.classList.remove('active');
    document.getElementById('pttLabel').textContent = 'HABLAR';
    document.getElementById('pttHint').textContent = 'Mantener presionado para hablar';

    hideSpeaker();

    if (mediaRecorder && mediaRecorder.state === 'recording') {
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

  function unlockAudioContext() {
    if (!globalAudioCtx) {
      globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (globalAudioCtx.state === 'suspended') {
      globalAudioCtx.resume().catch(() => {});
    }
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

    // Hands Free
    const btnHandsFree = document.getElementById('btnHandsFree');
    if (btnHandsFree) {
      btnHandsFree.addEventListener('click', () => {
        isHandsFreeMode = !isHandsFreeMode;
        if (isHandsFreeMode) {
          btnHandsFree.classList.add('active');
          btnHandsFree.style.color = 'var(--accent)';
          showToast('🎙️ Modo Manos Libres ACTIVADO');
          if (currentChannel || currentPrivateUser) {
            startVoiceRecognition();
          }
        } else {
          btnHandsFree.classList.remove('active');
          btnHandsFree.style.color = '';
          showToast('🛑 Modo Manos Libres DESACTIVADO');
          stopVoiceRecognition();
        }
      });
    }

    // Channel Users modal
    const channelUsersModal = document.getElementById('channelUsersModal');
    if (channelUsersModal) {
      channelUsersModal.addEventListener('click', (e) => {
        if (e.target === channelUsersModal) channelUsersModal.classList.remove('active');
      });
    }
    
    // Custom event: show channel users
    document.addEventListener('show_channel_users', () => {
      if (socket && currentRoom) {
        socket.emit('get_channel_users', { room: currentRoom });
      }
    });
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
