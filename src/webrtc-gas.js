/**
 * WebRTC-GAS ライブラリ
 * GAS API を利用して WebRTC 接続を確立するための JavaScript ライブラリ
 *
 * @version 1.0.0
 * @license MIT
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    // AMD
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    // CommonJS
    module.exports = factory();
  } else {
    // グローバル変数
    root.WebRTCGAS = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * イベントエミッター
   */
  class EventEmitter {
    constructor() {
      this._events = {};
    }

    /**
     * イベントリスナーを登録
     * @param {string} event - イベント名
     * @param {Function} callback - コールバック関数
     */
    on(event, callback) {
      if (!this._events[event]) {
        this._events[event] = [];
      }
      this._events[event].push(callback);
    }

    /**
     * イベントリスナーを解除
     * @param {string} event - イベント名
     * @param {Function} callback - コールバック関数
     */
    off(event, callback) {
      if (!this._events[event]) return;
      this._events[event] = this._events[event].filter(cb => cb !== callback);
    }

    /**
     * イベントを発火
     * @param {string} event - イベント名
     * @param {*} data - イベントデータ
     */
    emit(event, data) {
      if (!this._events[event]) return;
      this._events[event].forEach(callback => {
        try {
          callback(data);
        } catch (e) {
          console.error('イベントハンドラでエラー:', e);
        }
      });
    }
  }

  /**
   * WebRTC-GAS クライアント
   */
  class Client extends EventEmitter {
    /**
     * コンストラクタ
     * @param {Object} options - オプション
     * @param {string} options.apiUrl - GAS API の URL（必須）
     * @param {string} options.name - プレイヤー名（必須）
     * @param {string} [options.id] - ユーザーID（省略時は自動発行）
     * @param {string} [options.globalIp] - グローバルIP
     * @param {string[]} [options.friendList] - フレンドIDリスト
     * @param {string} [options.passphrase] - あいことば
     * @param {number} [options.pollingInterval=2000] - ポーリング間隔（ミリ秒）
     */
    constructor(options) {
      super();

      // 必須パラメータのチェック
      if (!options || !options.apiUrl) {
        throw new Error('apiUrl は必須です');
      }
      if (!options.name) {
        throw new Error('name は必須です');
      }

      this.apiUrl = options.apiUrl;
      this.name = options.name;
      this.id = options.id || null;
      this.globalIp = options.globalIp || '';
      this.friendList = options.friendList || [];
      this.passphrase = options.passphrase || '';
      this.pollingInterval = options.pollingInterval || 2000;

      // 状態
      this.status = 'idle';
      this.peerId = null;
      this.peerName = null;
      this.matchList = [];
      this.isConnected = false;

      // 内部状態
      this._pollingTimer = null;
      this._peerConnection = null;
      this._dataChannel = null;
      this._pendingCandidates = [];
      this._isOfferer = false;
      this._isProcessingSignal = false; // シグナル処理中フラグ
    }

    /**
     * サーバーに登録
     * @returns {Promise<void>}
     */
    async register() {
      try {
        const response = await this._apiCall({
          action: 'register',
          id: this.id,
          name: this.name,
          global_ip: this.globalIp,
          friend_list: this.friendList,
          passphrase: this.passphrase
        });

        if (!response.success) {
          throw new Error(response.message);
        }

        // IDが発行された場合は保存
        if (response.id) {
          this.id = response.id;
        }

        this.status = response.next_status;
        this.matchList = response.match_list || [];

        this.emit('registered', {
          id: this.id,
          matchList: this.matchList
        });

        // マッチング候補があれば通知
        if (this.matchList.length > 0) {
          this.emit('matchFound', { matchList: this.matchList });
        }

        // ポーリング開始
        this._startPolling();

      } catch (error) {
        this.emit('error', { error });
        throw error;
      }
    }

    /**
     * 指定した相手と接続
     * @param {string} peerId - 接続先のID
     * @returns {Promise<void>}
     */
    async connect(peerId) {
      this._isProcessingSignal = true; // シグナル処理中フラグON
      try {
        console.log('[WebRTC-GAS] connect() start:', peerId);
        this.peerId = peerId;
        this._isOfferer = true;

        // マッチリストから相手の名前を取得
        const peer = this.matchList.find(p => p.id === peerId);
        if (peer) {
          this.peerName = peer.name;
        }

        // WebRTC 接続を作成
        console.log('[WebRTC-GAS] Creating peer connection...');
        await this._createPeerConnection();

        // データチャネルを作成（オファー側）
        console.log('[WebRTC-GAS] Creating data channel...');
        this._dataChannel = this._peerConnection.createDataChannel('data');
        this._setupDataChannel();

        // オファーを作成
        console.log('[WebRTC-GAS] Creating offer...');
        const offer = await this._peerConnection.createOffer();
        await this._peerConnection.setLocalDescription(offer);

        // ICE候補が集まるまで少し待つ
        console.log('[WebRTC-GAS] Waiting for ICE candidates...');
        await this._waitForIceCandidates();

        // オファーを送信
        console.log('[WebRTC-GAS] Sending offer...');
        const response = await this._apiCall({
          action: 'sendsignal',
          id: this.id,
          peer_id: peerId,
          type: 'offer',
          sdp: this._peerConnection.localDescription,
          candidates: this._pendingCandidates
        });
        console.log('[WebRTC-GAS] Offer response:', response);

        if (!response.success) {
          throw new Error(response.message);
        }

        this.status = response.next_status;
        this._pendingCandidates = [];
        console.log('[WebRTC-GAS] connect() complete, status:', this.status);

      } catch (error) {
        console.error('[WebRTC-GAS] connect() error:', error);
        this.emit('error', { error });
        throw error;
      } finally {
        this._isProcessingSignal = false; // シグナル処理中フラグOFF
      }
    }

    /**
     * 切断
     */
    disconnect() {
      this._stopPolling();

      if (this._dataChannel) {
        this._dataChannel.close();
        this._dataChannel = null;
      }

      if (this._peerConnection) {
        this._peerConnection.close();
        this._peerConnection = null;
      }

      this.status = 'disconnected';
      this.isConnected = false;
      this.peerId = null;
      this.peerName = null;
      this._isProcessingSignal = false;

      this.emit('disconnected', { reason: 'user' });
    }

    /**
     * データを送信
     * @param {*} data - 送信データ
     */
    send(data) {
      if (!this._dataChannel || this._dataChannel.readyState !== 'open') {
        throw new Error('接続されていません');
      }

      const message = JSON.stringify(data);
      this._dataChannel.send(message);
    }

    /**
     * API呼び出し
     * @private
     */
    async _apiCall(data) {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        body: JSON.stringify(data),
        redirect: 'follow'
      });

      return await response.json();
    }

    /**
     * ポーリング開始
     * @private
     */
    _startPolling() {
      if (this._pollingTimer) return;

      this._pollingTimer = setInterval(() => {
        this._poll();
      }, this.pollingInterval);
    }

    /**
     * ポーリング停止
     * @private
     */
    _stopPolling() {
      if (this._pollingTimer) {
        clearInterval(this._pollingTimer);
        this._pollingTimer = null;
      }
    }

    /**
     * ポーリング実行
     * @private
     */
    async _poll() {
      try {
        console.log('[WebRTC-GAS] Poll request:', { id: this.id, peerId: this.peerId, status: this.status });
        const response = await this._apiCall({
          action: 'sendsignal',
          id: this.id,
          peer_id: this.peerId,
          status: this.status,
          type: 'polling'
        });
        console.log('[WebRTC-GAS] Poll response:', response);

        // エラーレスポンスの処理
        if (!response.success) {
          console.log('[WebRTC-GAS] Error response, next_status:', response.next_status);
          // 再登録が必要な場合は自動で再登録（ユーザー操作不要）
          if (response.next_status === 'register' || response.message === 'ユーザーが見つかりません') {
            await this._handleAutoReconnect();
          }
          return;
        }

        // 異常検知からの復帰（wait_offer に戻された場合）
        // シグナル処理中はスキップ（オファー/アンサー処理中の誤判定を防ぐ）
        if (response.next_status === 'wait_offer' && this.peerId && !this._isProcessingSignal) {
          console.log('異常検知からの復帰:', response.message);
          await this._handleRecovery();
        }

        // 状態に応じて処理
        if (response.type === 'offer') {
          // オファー受信
          await this._handleOffer(response);
        } else if (response.type === 'answer') {
          // アンサー受信
          await this._handleAnswer(response);
        } else if (response.type === 'ice') {
          // ICE受信
          await this._handleIce(response);
        } else if (response.match_list && response.match_list.length > 0) {
          // マッチング候補更新
          if (JSON.stringify(this.matchList) !== JSON.stringify(response.match_list)) {
            this.matchList = response.match_list;
            this.emit('matchFound', { matchList: this.matchList });
          }
        }

        // connected 状態になったらステータスを上書きしない（WebRTC接続完了を優先）
        if (this.status !== 'connected') {
          this.status = response.next_status;
        }

      } catch (error) {
        // ポーリングエラーは無視（次回リトライ）
        console.warn('ポーリングエラー:', error);
      }
    }

    /**
     * オファー処理
     * @private
     */
    async _handleOffer(response) {
      console.log('[WebRTC-GAS] _handleOffer start:', response.peer_id);
      this._isProcessingSignal = true; // シグナル処理中フラグON
      try {
        this.peerId = response.peer_id;
        this.peerName = response.peer_name || '';
        this._isOfferer = false;

        this.emit('offer', {
          peerId: response.peer_id,
          peerName: this.peerName
        });

        // WebRTC 接続を作成
        console.log('[WebRTC-GAS] Creating peer connection...');
        await this._createPeerConnection();

        // オファーを設定
        console.log('[WebRTC-GAS] Setting remote description (offer)...');
        await this._peerConnection.setRemoteDescription(response.sdp);

        // ICE候補を追加
        if (response.candidates) {
          console.log('[WebRTC-GAS] Adding ICE candidates:', response.candidates.length);
          for (const candidate of response.candidates) {
            await this._peerConnection.addIceCandidate(candidate);
          }
        }

        // アンサーを作成
        console.log('[WebRTC-GAS] Creating answer...');
        const answer = await this._peerConnection.createAnswer();
        await this._peerConnection.setLocalDescription(answer);

        // ICE候補が集まるまで少し待つ
        console.log('[WebRTC-GAS] Waiting for ICE candidates...');
        await this._waitForIceCandidates();

        // アンサーを送信
        console.log('[WebRTC-GAS] Sending answer...');
        const answerResponse = await this._apiCall({
          action: 'sendsignal',
          id: this.id,
          peer_id: this.peerId,
          type: 'answer',
          sdp: this._peerConnection.localDescription,
          candidates: this._pendingCandidates
        });
        console.log('[WebRTC-GAS] Answer response:', answerResponse);

        this._pendingCandidates = [];
        console.log('[WebRTC-GAS] _handleOffer complete');
      } catch (error) {
        console.error('[WebRTC-GAS] _handleOffer error:', error);
        throw error;
      } finally {
        this._isProcessingSignal = false; // シグナル処理中フラグOFF
      }
    }

    /**
     * アンサー処理
     * @private
     */
    async _handleAnswer(response) {
      console.log('[WebRTC-GAS] _handleAnswer start');
      this._isProcessingSignal = true; // シグナル処理中フラグON
      try {
        // アンサーを設定
        console.log('[WebRTC-GAS] Setting remote description (answer)...');
        await this._peerConnection.setRemoteDescription(response.sdp);

        // ICE候補を追加
        if (response.candidates) {
          console.log('[WebRTC-GAS] Adding ICE candidates:', response.candidates.length);
          for (const candidate of response.candidates) {
            await this._peerConnection.addIceCandidate(candidate);
          }
        }
        console.log('[WebRTC-GAS] _handleAnswer complete');
      } catch (error) {
        console.error('[WebRTC-GAS] _handleAnswer error:', error);
        throw error;
      } finally {
        this._isProcessingSignal = false; // シグナル処理中フラグOFF
      }
    }

    /**
     * ICE処理
     * @private
     */
    async _handleIce(response) {
      if (response.candidates && this._peerConnection) {
        for (const candidate of response.candidates) {
          await this._peerConnection.addIceCandidate(candidate);
        }
      }
    }

    /**
     * PeerConnection作成
     * @private
     */
    async _createPeerConnection() {
      const config = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      };

      this._peerConnection = new RTCPeerConnection(config);
      this._pendingCandidates = [];

      // ICE候補収集
      this._peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          this._pendingCandidates.push(event.candidate);
        }
      };

      // 接続状態変化
      this._peerConnection.onconnectionstatechange = () => {
        const state = this._peerConnection.connectionState;
        if (state === 'connected') {
          this.isConnected = true;
          this.status = 'connected';
          // 接続完了後はポーリング停止
          this._stopPolling();
          // サーバーに接続完了を通知（sdp/candidates削除のため）
          this._notifyConnected();
          this.emit('connected', {
            peerId: this.peerId,
            peerName: this.peerName
          });
        } else if (state === 'disconnected' || state === 'failed') {
          this.isConnected = false;
          this.emit('disconnected', { reason: state });
        }
      };

      // データチャネル受信（アンサー側）
      this._peerConnection.ondatachannel = (event) => {
        this._dataChannel = event.channel;
        this._setupDataChannel();
      };
    }

    /**
     * データチャネル設定
     * @private
     */
    _setupDataChannel() {
      this._dataChannel.onopen = () => {
        console.log('データチャネル接続');
      };

      this._dataChannel.onclose = () => {
        console.log('データチャネル切断');
      };

      this._dataChannel.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.emit('message', { data });
        } catch (e) {
          this.emit('message', { data: event.data });
        }
      };
    }

    /**
     * ICE候補収集を待つ
     * @private
     */
    _waitForIceCandidates() {
      return new Promise((resolve) => {
        // 最大1秒待つ、または gathering complete で終了
        const timeout = setTimeout(resolve, 1000);

        this._peerConnection.onicegatheringstatechange = () => {
          if (this._peerConnection.iceGatheringState === 'complete') {
            clearTimeout(timeout);
            resolve();
          }
        };
      });
    }

    /**
     * サーバーに接続完了を通知
     * sdp/candidates を削除してもらうため
     * @private
     */
    async _notifyConnected() {
      try {
        await this._apiCall({
          action: 'sendsignal',
          id: this.id,
          peer_id: this.peerId,
          status: 'connected',
          type: 'polling'
        });
        console.log('[WebRTC-GAS] Connected notification sent to server');
      } catch (error) {
        // 通知失敗は無視（接続自体は成功しているため）
        console.warn('[WebRTC-GAS] Failed to notify connected status:', error);
      }
    }

    /**
     * 自動再接続処理（ユーザー操作不要）
     * セッションが切れた場合に自動で再登録してマッチングを継続
     * @private
     */
    async _handleAutoReconnect() {
      console.log('[WebRTC-GAS] Auto reconnecting...');

      // WebRTC 接続をクリーンアップ
      if (this._dataChannel) {
        this._dataChannel.close();
        this._dataChannel = null;
      }

      if (this._peerConnection) {
        this._peerConnection.close();
        this._peerConnection = null;
      }

      // 接続関連の状態をリセット（名前は保持）
      this.id = null;
      this.peerId = null;
      this.peerName = null;
      this.matchList = [];
      this._pendingCandidates = [];
      this._isOfferer = false;
      this.isConnected = false;
      this._isProcessingSignal = false;

      // ポーリング停止
      this._stopPolling();

      // 自動で再登録
      try {
        await this.register();
        console.log('[WebRTC-GAS] Auto reconnect successful');
      } catch (error) {
        console.error('[WebRTC-GAS] Auto reconnect failed:', error);
        this.emit('error', { error });
      }
    }

    /**
     * 異常検知からの復帰処理（wait_offer に戻る）
     * IDは保持したまま、接続状態のみリセット
     * @private
     */
    async _handleRecovery() {
      // WebRTC 接続をクリーンアップ
      if (this._dataChannel) {
        this._dataChannel.close();
        this._dataChannel = null;
      }

      if (this._peerConnection) {
        this._peerConnection.close();
        this._peerConnection = null;
      }

      // 接続関連の状態をリセット（IDは保持）
      this.peerId = null;
      this.peerName = null;
      this.matchList = [];
      this._pendingCandidates = [];
      this._isOfferer = false;
      this.isConnected = false;
      this._isProcessingSignal = false;

      // ポーリングは継続（再登録不要）
      // 次のポーリングで新しいマッチング候補を受け取る
    }

    /**
     * リセット処理（再登録が必要）
     * @private
     */
    async _handleReset(response) {
      const nextStatus = response.next_status;
      const message = response.message;

      // WebRTC 接続をクリーンアップ
      if (this._dataChannel) {
        this._dataChannel.close();
        this._dataChannel = null;
      }

      if (this._peerConnection) {
        this._peerConnection.close();
        this._peerConnection = null;
      }

      // 状態をリセット
      this.peerId = null;
      this.peerName = null;
      this.matchList = [];
      this._pendingCandidates = [];
      this._isOfferer = false;
      this._isProcessingSignal = false;

      // ポーリング停止
      this._stopPolling();
      this.status = 'idle';
      this.id = null;

      // リセットイベントを発火（アプリケーション側で再登録を促す）
      this.emit('reset', {
        nextStatus: nextStatus,
        message: message
      });
    }
  }

  // エクスポート
  return {
    Client: Client
  };
}));
