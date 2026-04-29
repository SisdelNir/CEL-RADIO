// ═══════════════════════════════════════════════════════════════
// CEL-RADIO — RadioMediaClient (WebRTC + Mediasoup-client)
// Maneja la conexión de audio en tiempo real vía WebRTC SFU
// ═══════════════════════════════════════════════════════════════
// IMPORTANTE: Este archivo requiere que mediasoup-client.bundle.js
// esté cargado ANTES en el HTML (expone window.mediasoupClient)

(function() {
  'use strict';

  class RadioMediaClient {
    constructor() {
      this.socket = null;
      this.device = null;           // mediasoup Device
      this.sendTransport = null;    // Transport para ENVIAR audio
      this.recvTransport = null;    // Transport para RECIBIR audio
      this.producer = null;         // Producer de audio (cuando PTT activo)
      this.consumers = new Map();   // Map<consumerId, Consumer>
      this.currentRoom = null;
      this.micStream = null;        // MediaStream del micrófono
      this.onSpeakerCallback = null;  // Callback cuando alguien habla
      this.onSpeakerStopCallback = null; // Callback cuando alguien deja de hablar
      this._joined = false;
      this._producing = false;
    }

    // ════════════════════════════════════════
    // INICIALIZACIÓN
    // ════════════════════════════════════════

    /**
     * Inicializa el dispositivo mediasoup-client con las capacidades del router
     * @param {Socket} socket - Instancia de socket.io
     */
    async init(socket) {
      this.socket = socket;

      if (!window.mediasoupClient) {
        console.error('[MediaClient] mediasoup-client no está cargado. Usando fallback Socket.io.');
        return false;
      }

      try {
        this.device = new window.mediasoupClient.Device();
        
        // Obtener las capacidades del router del servidor
        const routerRtpCapabilities = await this._request('ms_getRouterCapabilities');
        
        await this.device.load({ routerRtpCapabilities });
        console.log('[MediaClient] Device cargado correctamente. canProduce audio:', this.device.canProduce('audio'));

        // Escuchar nuevos productores en la sala
        this.socket.on('ms_newProducer', async (data) => {
          // INTEGRIDAD: Ignorar producers que no son de nuestra sala activa
          if (!this.currentRoom || data.roomName && data.roomName !== this.currentRoom) {
            console.log(`[MediaClient] ms_newProducer ignorado — no es de nuestra sala (${this.currentRoom})`);
            return;
          }
          console.log('[MediaClient] Nuevo producer en la sala:', data);
          await this._consumeProducer(data.producerId, data.senderName, data.senderInitials);
        });

        // Escuchar cuando un producer se cierra
        this.socket.on('ms_producerClosed', (data) => {
          const consumer = this.consumers.get(data.producerId);
          if (consumer) {
            consumer.close();
            this.consumers.delete(data.producerId);
          }
          // Notificar que el speaker dejó de hablar
          if (this.onSpeakerStopCallback) {
            this.onSpeakerStopCallback(data.senderName);
          }
        });

        return true;
      } catch (err) {
        console.error('[MediaClient] Error inicializando device:', err);
        return false;
      }
    }

    // ════════════════════════════════════════
    // UNIRSE / SALIR DE UNA SALA
    // ════════════════════════════════════════

    /**
     * Unirse a una sala de audio (canal o llamada privada)
     * @param {string} roomName - Nombre de la sala
     */
    async joinRoom(roomName) {
      if (!this.device || !this.device.loaded) {
        console.warn('[MediaClient] Device no inicializado, no se puede unir a sala');
        return;
      }

      // Guard: si ya estamos en esta sala exacta, no hacer leave/rejoin innecesario
      if (this.currentRoom === roomName && this._joined) {
        console.log(`[MediaClient] Ya estamos en sala ${roomName}, skip rejoin`);
        return;
      }

      // Si estamos en una sala diferente, salir primero
      if (this.currentRoom && this.currentRoom !== roomName) {
        await this.leaveRoom();
      }

      this.currentRoom = roomName;

      try {
        // Crear transport de RECEPCIÓN (para escuchar a otros)
        await this._createRecvTransport();
        
        // Notificar al servidor que nos unimos (para recibir producers existentes)
        const existingProducers = await this._request('ms_joinRoom', {
          roomName,
          rtpCapabilities: this.device.rtpCapabilities
        });

        this._joined = true;

        // Consumir producers que ya existen en la sala
        if (existingProducers && existingProducers.length > 0) {
          for (const p of existingProducers) {
            await this._consumeProducer(p.producerId, p.senderName, p.senderInitials);
          }
        }

        console.log(`[MediaClient] Unido a sala: ${roomName}`);
      } catch (err) {
        console.error('[MediaClient] Error al unirse a la sala:', err);
      }
    }

    /**
     * Salir de la sala actual
     */
    async leaveRoom() {
      // Detener producción si está activa
      await this.stopProducing();

      // Cerrar todos los consumers
      for (const [id, consumer] of this.consumers) {
        consumer.close();
      }
      this.consumers.clear();

      // Cerrar transports
      if (this.sendTransport) {
        this.sendTransport.close();
        this.sendTransport = null;
      }
      if (this.recvTransport) {
        this.recvTransport.close();
        this.recvTransport = null;
      }

      // Notificar al servidor
      if (this.socket && this.currentRoom) {
        this.socket.emit('ms_leaveRoom', { roomName: this.currentRoom });
      }

      this._joined = false;
      this.currentRoom = null;
      console.log('[MediaClient] Salió de la sala');
    }

    // ════════════════════════════════════════
    // PRODUCCIÓN (ENVIAR AUDIO - PTT)
    // ════════════════════════════════════════

    /**
     * Comenzar a enviar audio (cuando se presiona PTT)
     * @param {MediaStream} micStream - Stream del micrófono
     * @param {object} senderInfo - {name, initials}
     */
    async startProducing(micStream, senderInfo) {
      if (!this.device || !this.device.loaded || !this.currentRoom) {
        console.warn('[MediaClient] No se puede producir: device no listo o sin sala');
        return false;
      }

      if (this._producing) {
        console.warn('[MediaClient] Ya está produciendo');
        return true;
      }

      try {
        this.micStream = micStream;

        // Crear transport de ENVÍO si no existe
        if (!this.sendTransport) {
          await this._createSendTransport();
        }

        // Obtener el track de audio del micrófono
        const audioTrack = micStream.getAudioTracks()[0];
        if (!audioTrack) {
          console.error('[MediaClient] No se encontró track de audio en el stream');
          return false;
        }

        // Crear el Producer
        this.producer = await this.sendTransport.produce({
          track: audioTrack,
          codecOptions: {
            opusStereo: false,     // Mono para radio
            opusDtx: true,         // Detección de silencio
            opusFec: true,         // Forward Error Correction
            opusMaxPlaybackRate: 24000 // Calidad optimizada para voz (no música)
          },
          appData: {
            senderName: senderInfo.name,
            senderInitials: senderInfo.initials
          }
        });

        this.producer.on('transportclose', () => {
          console.log('[MediaClient] Producer transport cerrado');
          this.producer = null;
          this._producing = false;
        });

        this.producer.on('trackended', () => {
          console.log('[MediaClient] Track de audio terminó');
          this.stopProducing();
        });

        this._producing = true;
        console.log('[MediaClient] Produciendo audio (PTT activo)');
        return true;
      } catch (err) {
        console.error('[MediaClient] Error al empezar a producir:', err);
        return false;
      }
    }

    /**
     * Dejar de enviar audio (cuando se suelta PTT)
     */
    async stopProducing() {
      if (!this._producing || !this.producer) return;

      try {
        this.producer.close();
        
        // Notificar al servidor que cerramos el producer
        if (this.socket) {
          this.socket.emit('ms_closeProducer', { producerId: this.producer.id });
        }
      } catch (err) {
        console.warn('[MediaClient] Error cerrando producer:', err);
      }

      this.producer = null;
      this._producing = false;
      console.log('[MediaClient] Producción detenida (PTT liberado)');
    }

    // ════════════════════════════════════════
    // CALLBACKS PARA UI
    // ════════════════════════════════════════

    /**
     * Registrar callback cuando un nuevo speaker empieza a hablar
     * @param {Function} callback - (senderName, senderInitials) => void
     */
    onNewSpeaker(callback) {
      this.onSpeakerCallback = callback;
    }

    /**
     * Registrar callback cuando un speaker deja de hablar
     * @param {Function} callback - (senderName) => void
     */
    onSpeakerStop(callback) {
      this.onSpeakerStopCallback = callback;
    }

    /**
     * Verificar si el sistema WebRTC está disponible y funcional
     */
    isAvailable() {
      return !!(this.device && this.device.loaded);
    }

    // ════════════════════════════════════════
    // MÉTODOS PRIVADOS
    // ════════════════════════════════════════

    /**
     * Crear transport de ENVÍO (Send Transport)
     */
    async _createSendTransport() {
      const transportData = await this._request('ms_createTransport', {
        roomName: this.currentRoom,
        direction: 'send'
      });

      this.sendTransport = this.device.createSendTransport({
        id: transportData.id,
        iceParameters: transportData.iceParameters,
        iceCandidates: transportData.iceCandidates,
        dtlsParameters: transportData.dtlsParameters,
        iceServers: transportData.iceServers || []
      });

      // Evento: el transport necesita conectarse al servidor
      this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          await this._request('ms_connectTransport', {
            transportId: this.sendTransport.id,
            dtlsParameters
          });
          callback();
        } catch (err) {
          errback(err);
        }
      });

      // Evento: el transport va a producir (enviar audio)
      this.sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          const { producerId } = await this._request('ms_produce', {
            transportId: this.sendTransport.id,
            roomName: this.currentRoom,
            kind,
            rtpParameters,
            appData
          });
          callback({ id: producerId });
        } catch (err) {
          errback(err);
        }
      });

      this.sendTransport.on('connectionstatechange', (state) => {
        console.log(`[MediaClient] SendTransport estado: ${state}`);
        if (state === 'failed' || state === 'disconnected') {
          console.warn('[MediaClient] SendTransport perdió conexión');
        }
      });

      console.log('[MediaClient] SendTransport creado');
    }

    /**
     * Crear transport de RECEPCIÓN (Recv Transport)
     */
    async _createRecvTransport() {
      const transportData = await this._request('ms_createTransport', {
        roomName: this.currentRoom,
        direction: 'recv'
      });

      this.recvTransport = this.device.createRecvTransport({
        id: transportData.id,
        iceParameters: transportData.iceParameters,
        iceCandidates: transportData.iceCandidates,
        dtlsParameters: transportData.dtlsParameters,
        iceServers: transportData.iceServers || []
      });

      // Evento: el transport necesita conectarse al servidor
      this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          await this._request('ms_connectTransport', {
            transportId: this.recvTransport.id,
            dtlsParameters
          });
          callback();
        } catch (err) {
          errback(err);
        }
      });

      this.recvTransport.on('connectionstatechange', (state) => {
        console.log(`[MediaClient] RecvTransport estado: ${state}`);
      });

      console.log('[MediaClient] RecvTransport creado');
    }

    /**
     * Consumir audio de un producer remoto
     */
    async _consumeProducer(producerId, senderName, senderInitials) {
      if (!this.recvTransport) {
        console.warn('[MediaClient] RecvTransport no disponible');
        return;
      }

      try {
        const consumerData = await this._request('ms_consume', {
          producerId,
          roomName: this.currentRoom,
          rtpCapabilities: this.device.rtpCapabilities
        });

        const consumer = await this.recvTransport.consume({
          id: consumerData.id,
          producerId: consumerData.producerId,
          kind: consumerData.kind,
          rtpParameters: consumerData.rtpParameters
        });

        this.consumers.set(producerId, consumer);

        // Crear un elemento de audio para reproducir
        const audioEl = new Audio();
        audioEl.srcObject = new MediaStream([consumer.track]);
        audioEl.autoplay = true;
        audioEl.play().catch(err => {
          console.warn('[MediaClient] Error auto-play (interacción requerida):', err);
        });

        // Notificar a la UI que hay un nuevo speaker
        if (this.onSpeakerCallback) {
          this.onSpeakerCallback(senderName, senderInitials);
        }

        // Confirmar al servidor que empezamos a consumir
        this.socket.emit('ms_consumerResumed', { consumerId: consumer.id });

        consumer.on('trackended', () => {
          console.log('[MediaClient] Track de consumer terminó');
          this.consumers.delete(producerId);
        });

        consumer.on('transportclose', () => {
          this.consumers.delete(producerId);
        });

        console.log(`[MediaClient] Consumiendo audio de: ${senderName}`);
      } catch (err) {
        console.error('[MediaClient] Error consumiendo producer:', err);
      }
    }

    /**
     * Utilidad: Enviar request al servidor vía socket.io y esperar respuesta
     */
    _request(event, data = {}) {
      return new Promise((resolve, reject) => {
        if (!this.socket) {
          return reject(new Error('Socket no conectado'));
        }
        this.socket.emit(event, data, (response) => {
          if (response && response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });
      });
    }
  }

  // ═══ Exponer globalmente ═══
  window.RadioMediaClient = RadioMediaClient;

})();
