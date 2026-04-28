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
    requestMicrophone();
    setupSocketReceivers();
  }

  async function requestMicrophone() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn("Microphone access denied or error:", err);
      showToast("⚠️ Activa el permiso del micrófono");
    }
  }

  function setupSocketReceivers() {
    if (!socket) return;
    
    socket.on('receive_voice', async (data) => {
      const { audioBlob, sender } = data;
      if (!audioBlob) return;

      // Reproducir audio
      const blob = new Blob([audioBlob], { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      
      // Mostrar quién habla
      showSpeaker(sender.name, sender.initials, false);
      
      audio.onended = () => {
        hideSpeaker();
        URL.revokeObjectURL(url);
      };
      
      try {
        await audio.play();
      } catch (err) {
        console.warn("Autoplay prevent:", err);
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
    if (userDisplay) {
      userDisplay.textContent = `👤 ${userName}`;
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
      startVoiceRecognition();
      
      if (socket) {
        let tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
        const roomName = `private_${tenant.id}_${Math.min(loggedInUser.id, currentPrivateUser.id)}_${Math.max(loggedInUser.id, currentPrivateUser.id)}`;
        currentRoom = roomName;
        socket.emit('join_channel', { channelId: roomName, empresaId: tenant.id, userName: loggedInUser.nombre });
      }
    } else {
      labelEl.textContent = 'Canal Activo';
      nameEl.textContent = `📻 ${currentChannel.name}`;
      usersEl.innerHTML = `👥 <span id="userCount">${currentChannel.users}</span> conectados`;
      idleIcon.textContent = currentChannel.icon || '📻';
      idleText.textContent = 'Canal libre — listo para hablar';
      startVoiceRecognition();
      
      if (socket) {
        let tenant = JSON.parse(sessionStorage.getItem('cel_empresa') || sessionStorage.getItem('cel_tenant') || '{}');
        const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
        currentRoom = `empresa_${tenant.id}_canal_${currentChannel.id}`;
        socket.emit('join_channel', { channelId: currentChannel.id, empresaId: tenant.id, userName: loggedInUser.nombre });
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
      // Restart si seguimos conectados
      if (currentChannel || currentPrivateUser) {
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

    // Show self as speaker
    showSpeaker('TÚ', '🎙️', true);

    // Vibrate feedback
    if (navigator.vibrate) navigator.vibrate(50);
    
    // Start MediaRecorder
    try {
      audioChunks = [];
      mediaRecorder = new MediaRecorder(micStream);
      
      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };
      
      mediaRecorder.onstop = () => {
        if (audioChunks.length > 0 && socket && currentRoom) {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
          
          socket.emit('transmit_voice', {
            room: currentRoom,
            audioBlob: audioBlob,
            sender: {
              name: loggedInUser.nombre || 'Piloto',
              initials: (loggedInUser.nombre || 'P').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()
            }
          });
        }
      };
      
      mediaRecorder.start();
    } catch (e) {
      console.warn("Error starting MediaRecorder:", e);
    }
  }

  function stopTransmit() {
    if (!isTransmitting) return;
    isTransmitting = false;

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
    // Filtrar al propio usuario de la lista de llamadas privadas
    const loggedInUser = JSON.parse(sessionStorage.getItem('cel_user') || '{}');
    const otherUsers = users.filter(u => u.id !== loggedInUser.id);

    if (otherUsers.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">
          <div style="font-size: 48px; margin-bottom: 16px; opacity: 0.5;">👤</div>
          <h3 style="color: #fff; margin-bottom: 8px;">Sin Contactos</h3>
          <p>No hay otros usuarios registrados en tu empresa para llamadas privadas.</p>
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
          <div class="user-status-dot ${u.online ? 'online' : 'offline'}"></div>
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
          document.getElementById('privateModal').classList.remove('active');
          showToast(`📞 Línea privada conectada con ${u.name}`);
        } else {
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
