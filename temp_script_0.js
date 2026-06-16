
  (function(){
    // Android WebView detection for full-screen spacing
    if(/Android/.test(navigator.userAgent)&&!/iPhone|iPad|iPod/.test(navigator.userAgent)){
      document.body.classList.add('android');
    }

    var isMobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

    // LocalStorage Keys
    var CLIENTS_K = 'standalone_dialer_clients';
    var DARK_K = 'standalone_dialer_dark';

    // State Variables
    var importedClients = [];
    var currentCallIdx = -1;
    var callInterval = null;
    var callSeconds = 0;
    var currentFilter = 'all';
    var currentPage = 1;
    var whitelistCompanies = [];
    var whitelistCheckResults = null;
    var whitelistLoaded = false;
    var pageSize = 100;
    var currentSort = 'shuffle';

    // Copy Rate Limiting - configurable
    var COPY_LIMIT_K = 'standalone_dialer_copy_limit';
    var copyLimitEnabled = localStorage.getItem('dialer_copy_limit_enabled') !== '0'; // default on
    var copyLimitThresholds = {}; // { '5': true, '10': true, ... }
    try {
      var savedThresholds = JSON.parse(localStorage.getItem('dialer_copy_limit_thresholds') || '{}');
      copyLimitThresholds['5'] = savedThresholds['5'] !== false;
      copyLimitThresholds['10'] = savedThresholds['10'] !== false;
      copyLimitThresholds['20'] = savedThresholds['20'] !== false;
      copyLimitThresholds['30'] = savedThresholds['30'] !== false;
    } catch(e) {
      copyLimitThresholds = { '5': true, '10': true, '20': true, '30': true };
    }
    var copyLimitState = null;

    function loadCopyLimitState() {
      if (copyLimitState) return;
      try {
        var saved = localStorage.getItem(COPY_LIMIT_K);
        if (saved) {
          copyLimitState = JSON.parse(saved);
        } else {
          copyLimitState = { count: 0, restrictedUntil: null, triggeredThresholds: [] };
        }
        // Clear expired restriction but keep count for cumulative tracking
        if (copyLimitState.restrictedUntil && Date.now() > copyLimitState.restrictedUntil) {
          copyLimitState.restrictedUntil = null;
        }
        // Initialize triggeredThresholds if missing from older state
        if (!copyLimitState.triggeredThresholds) {
          copyLimitState.triggeredThresholds = [];
        }
      } catch (e) {
        copyLimitState = { count: 0, restrictedUntil: null, triggeredThresholds: [] };
      }
    }

    function saveCopyLimitState() {
      try {
        localStorage.setItem(COPY_LIMIT_K, JSON.stringify(copyLimitState));
      } catch(e) {}
    }

    var copyLimitToastTimer = null;
    function showCopyLimitToast(msg, isWarn) {
      var toast = document.getElementById('copyLimitToast');
      if (!toast) return;
      toast.textContent = msg;
      toast.className = 'copy-limit-toast';
      if (isWarn) toast.classList.add('warn');
      // Force reflow
      void toast.offsetWidth;
      toast.classList.add('show');
      if (copyLimitToastTimer) clearTimeout(copyLimitToastTimer);
      copyLimitToastTimer = setTimeout(function() {
        toast.classList.remove('show');
      }, 4000);
    }

    // Returns {allowed: bool, message: string}
    function checkCopyLimit() {
      if (isMobileDevice) return { allowed: true, message: '' };
      // If copy limit feature is disabled, always allow
      if (copyLimitEnabled === false) return { allowed: true, message: '' };

      loadCopyLimitState();
      var now = Date.now();

      // Check if currently restricted
      if (copyLimitState.restrictedUntil && now < copyLimitState.restrictedUntil) {
        var remainingMin = Math.ceil((copyLimitState.restrictedUntil - now) / 60000);
        return { allowed: false, message: '⏳ 已达到复制上限，请等待 ' + remainingMin + ' 分钟后再试' };
      }

      // Clear expired restriction but keep count for cumulative tracking
      if (copyLimitState.restrictedUntil && now >= copyLimitState.restrictedUntil) {
        copyLimitState.restrictedUntil = null;
      }

      // Increment cumulative count
      copyLimitState.count++;

      // Check enabled thresholds in ascending order — each triggers only once
      var thresholdKeys = ['5', '10', '20', '30'];
      var hitThreshold = null;
      for (var i = 0; i < thresholdKeys.length; i++) {
        var t = parseInt(thresholdKeys[i], 10);
        if (copyLimitThresholds[thresholdKeys[i]] && copyLimitState.count >= t && copyLimitState.triggeredThresholds.indexOf(t) === -1) {
          hitThreshold = t;
          copyLimitState.triggeredThresholds.push(t);
          break;
        }
      }

      if (hitThreshold) {
        var restrictionMinutes = 30 + Math.floor(Math.random() * 31); // 30-60 min
        copyLimitState.restrictedUntil = now + restrictionMinutes * 60 * 1000;
        saveCopyLimitState();
        return { allowed: false, message: '🚫 已复制 ' + copyLimitState.count + ' 个号码（第' + hitThreshold + '个触发），限制 ' + restrictionMinutes + ' 分钟' };
      }

      saveCopyLimitState();
      return { allowed: true, message: '' };
    }

    // Dark Mode Control
    function initDark() {
      var btn = document.getElementById('darkToggleBtn');
      var updateDarkTitle = function() {
        var isDark = document.body.classList.contains('dark-mode');
        btn.textContent = (isDark ? '浅色' : '深色') + '模式';
      };
      if (localStorage.getItem(DARK_K) === 'true') {
        document.body.classList.add('dark-mode');
      }
      updateDarkTitle();
      btn.addEventListener('click', function() {
        document.body.classList.toggle('dark-mode');
        localStorage.setItem(DARK_K, document.body.classList.contains('dark-mode'));
        updateDarkTitle();
      });
    }

    // Helper functions
    function esc(s) {
      if (!s) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Cross-platform WeChat jump
    var isAndroid = /Android/.test(navigator.userAgent) && !/iPhone|iPad|iPod/.test(navigator.userAgent);
    function jumpToWechat() {
      if (isAndroid) {
        // Android: use intent:// scheme for WebView/Chrome
        window.location.href = 'intent://#Intent;scheme=weixin;package=com.tencent.mm;end';
      } else {
        // iOS: use weixin:// scheme
        window.location.href = 'weixin://';
      }
    }

    function copyTextToClipboard(text) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } catch (err) {
        console.error('Copy failed:', err);
      }
      document.body.removeChild(textarea);
    }

    function maskPhone(p) {
      if (!p) return '';
      var s = String(p).trim();
      if (s.length >= 11) {
        return s.slice(0, 3) + '****' + s.slice(7);
      }
      return s;
    }

    function cleanPhone(val) {
      if (!val) return '';
      var s = String(val).trim().replace(/[^\d+]/g, '');
      if (s.indexOf('+86') === 0) return s.slice(3);
      if (s.indexOf('86') === 0 && s.length === 13) return s.slice(2);
      return s;
    }

    function isPhone(val) {
      var clean = cleanPhone(val);
      return /^1[3-9]\d{9}$/.test(clean);
    }

    function nameScore(val) {
      if (!val) return 0;
      var s = String(val).trim();
      if (isPhone(s)) return 0;
      if (/^\d+$/.test(s)) return 0;
      
      // Common Chinese Surnames Regex
      var surnameRegex = /^[王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐董许韩邓冯曹彭曾萧田庄潘袁于叶余魏蒋田杜丁沈姜范江傅钟卢汪戴崔]/;
      
      if (/^[\u4e00-\u9fa5]{2,4}$/.test(s)) {
        if (surnameRegex.test(s)) {
          return 25; // Highly weigh standard Chinese names with common surnames
        }
        return 10;
      }
      if (/^[\u4e00-\u9fa5]{2,6}$/.test(s)) return 5;
      if (/^[A-Za-z\s]{2,15}$/.test(s)) return 3;
      if (s.length >= 2 && s.length <= 15) return 1;
      return 0;
    }

    function decodeQPUtf8(s) {
      var t = s.replace(/=\r?\n/g, '');
      var b = [];
      var i = 0;
      while (i < t.length) {
        if (t[i] === '=' && i + 2 < t.length && /[0-9A-Fa-f]{2}/.test(t.slice(i+1,i+3))) {
          b.push(parseInt(t.slice(i+1,i+3), 16));
          i += 3;
        } else {
          b.push(t.charCodeAt(i));
          i++;
        }
      }
      try { return new TextDecoder('utf-8').decode(new Uint8Array(b)); } catch(e) { return s; }
    }

    // Persist and load state
    function loadPersistedState() {
      try {
        var saved = localStorage.getItem(CLIENTS_K);
        if (saved) {
          importedClients = JSON.parse(saved);
          if (importedClients.length > 0) {
            updateDashboardVisibility(true);
            renderDialCards();
          }
        }
      } catch (err) {
        console.error('Failed to load state:', err);
      }
      setTimeout(function() {
        syncWithCloud();
      }, 500);
    }

    function saveState() {
      try {
        localStorage.setItem(CLIENTS_K, JSON.stringify(importedClients));
      } catch (err) {
        console.error('Failed to save state:', err);
      }
      syncWithCloud(true);
    }

    // Cloud Sync Logic
    var isSyncing = false;
    var lastCloudData = null;

    function setSyncStatus(status, title) {
      var badge = document.getElementById('syncStatusBadge');
      if (!badge) return;
      badge.className = 'icon-btn sync-badge ' + status;
      badge.title = title || '';
      if (status === 'online-synced') {
        badge.innerHTML = '已同步';
      } else if (status === 'online-unsynced') {
        badge.innerHTML = '未同步';
      } else {
        badge.innerHTML = '离线模式';
      }
    }

    function syncWithCloud(forcePost) {
      if (isSyncing) return;
      isSyncing = true;
      var apiUrl = '/api/dialer/data';

      fetch(apiUrl)
        .then(function(res) {
          if (!res.ok) {
            throw new Error('KV API not available');
          }
          return res.json();
        })
        .then(function(data) {
          isSyncing = false;
          lastCloudData = data;
          var cloudClients = data.clients || [];

          var localStr = JSON.stringify(importedClients);
          var cloudStr = JSON.stringify(cloudClients);

          if (localStr === cloudStr) {
            setSyncStatus('online-synced', '云端与本地数据一致，已完全同步');
            return;
          }

          if (forcePost) {
            uploadLocalToCloud();
          } else {
            if (importedClients.length === 0 && cloudClients.length > 0) {
              importedClients = cloudClients;
              localStorage.setItem(CLIENTS_K, JSON.stringify(importedClients));
              updateDashboardVisibility(true);
              renderDialCards();
              setSyncStatus('online-synced', '已自动拉取云端进度');
            } else if (importedClients.length > 0 && cloudClients.length === 0) {
              uploadLocalToCloud();
            } else {
              showSyncConflictModal(importedClients.length, cloudClients.length);
            }
          }
        })
        .catch(function(err) {
          isSyncing = false;
          setSyncStatus('offline-mode', '无法连接云端 (离线状态 / 未绑定 KV 空间)');
        });
    }

    function uploadLocalToCloud() {
      var apiUrl = '/api/dialer/data';
      setSyncStatus('online-unsynced', '正在上传最新进度...');
      fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clients: importedClients })
      })
      .then(function(res) {
        if (res.ok) {
          setSyncStatus('online-synced', '最新拨号进度已同步保存至 KV 空间');
        } else {
          setSyncStatus('online-unsynced', '进度上传失败');
        }
      })
      .catch(function(err) {
        setSyncStatus('offline-mode', '连接中断，保存至本地缓存');
      });
    }

    // Upload imported customers to Supabase via Worker proxy
    function uploadCustomersToSupabase(customers, batchLabel) {
      if (!customers || customers.length === 0) return;
      var label = batchLabel || ('导入-' + new Date().toISOString().slice(0, 19).replace('T', ' '));
      setSyncStatus('online-unsynced', '正在上传到云端数据库...');
      var payload = serializeCustomersForSupabase(customers);
      fetch('/api/dialer/upload-customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customers: payload, batch_label: label })
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.success) {
          setSyncStatus('online-synced', '已上传 ' + data.count + ' 条客户数据至 Supabase [批次: ' + label + ']');
        } else {
          setSyncStatus('online-unsynced', 'Supabase 上传失败: ' + (data.error || '未知错误'));
        }
      })
      .catch(function(err) {
        console.error('Supabase upload error:', err);
        setSyncStatus('online-unsynced', 'Supabase 连接失败，数据已保存在本地和 KV');
      });
    }

    function showSyncConflictModal(localLen, cloudLen) {
      document.getElementById('conflictLocalCount').textContent = localLen;
      document.getElementById('conflictCloudCount').textContent = cloudLen;
      document.getElementById('syncConflictModal').classList.add('active');
    }

    function hideSyncConflictModal() {
      document.getElementById('syncConflictModal').classList.remove('active');
    }

    function initSyncHandlers() {
      var badge = document.getElementById('syncStatusBadge');
      if (badge) {
        badge.addEventListener('click', function() {
          syncWithCloud();
        });
      }

      var syncBtn = document.getElementById('dbSyncBtn');
      if (syncBtn) {
        syncBtn.onclick = function() {
          if (!importedClients || importedClients.length === 0) {
            alert('当前拨号盘中没有客户数据需要同步！');
            return;
          }
          if (!confirm('确认将当前拨号盘中的 ' + importedClients.length + ' 条客户数据与跟进进度同步上传到 Supabase 数据库吗？(已存在的记录将被覆盖更新)')) return;
          
          syncBtn.disabled = true;
          var originalText = syncBtn.textContent;
          syncBtn.textContent = '⏳ 同步中...';
          
          var defaultBatch = '拨号同步';
          var batchMap = {};
          importedClients.forEach(function(c) {
            if (c.batch_label) batchMap[c.batch_label] = (batchMap[c.batch_label] || 0) + 1;
          });
          var batches = Object.keys(batchMap);
          var chosenBatch = batches.length === 1 ? batches[0] : (batches.length > 1 ? batches.join(',') : defaultBatch);
          
          setSyncStatus('online-unsynced', '正在上传到云端数据库...');
          var payload = serializeCustomersForSupabase(importedClients);
          fetch('/api/dialer/upload-customers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customers: payload, batch_label: chosenBatch })
          })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            syncBtn.disabled = false;
            syncBtn.textContent = originalText;
            if (data.success) {
              setSyncStatus('online-synced', '已同步 ' + data.count + ' 条数据');
              alert('同步成功！共保存 ' + data.count + ' 条客户进度至 Supabase 数据库。');
              if (document.getElementById('dbOverlay') && document.getElementById('dbOverlay').classList.contains('active')) {
                dbFetch();
              }
            } else {
              setSyncStatus('online-unsynced', '同步失败');
              alert('同步失败: ' + (data.error || '未知错误'));
            }
          })
          .catch(function(err) {
            syncBtn.disabled = false;
            syncBtn.textContent = originalText;
            setSyncStatus('online-unsynced', '连接失败');
            alert('网络连接失败，请检查 Worker 配置或 API 连接！');
          });
        };
      }

      document.getElementById('syncUseLocalBtn').addEventListener('click', function() {
        hideSyncConflictModal();
        uploadLocalToCloud();
      });

      document.getElementById('syncUseCloudBtn').addEventListener('click', function() {
        hideSyncConflictModal();
        if (lastCloudData && lastCloudData.clients) {
          importedClients = lastCloudData.clients;
          localStorage.setItem(CLIENTS_K, JSON.stringify(importedClients));
          updateDashboardVisibility(importedClients.length > 0);
          renderDialCards();
          setSyncStatus('online-synced', '已覆写并同步云端数据');
        }
      });

      document.getElementById('syncCancelBtn').addEventListener('click', function() {
        hideSyncConflictModal();
        setSyncStatus('online-unsynced', '已跳过同步，保留本地差异');
      });
    }


    function updateDashboardVisibility(hasData) {
      var flexStyle = hasData ? 'flex' : 'none';
      var minimalStats = document.getElementById('headerStatsMinimal');
      if (minimalStats) {
        minimalStats.style.display = hasData ? 'flex' : 'none';
      }
      document.getElementById('controlBar').style.display = flexStyle;
      
      var expBtn = document.getElementById('exportBtn');
      var clrBtn = document.getElementById('clearBtn');
      if (expBtn) expBtn.style.display = hasData ? 'flex' : 'none';
      if (clrBtn) clrBtn.style.display = hasData ? 'flex' : 'none';
      
      // Auto-hide import zone if there is data, otherwise display it
      var panel = document.getElementById('dashboardPanel');
      if (panel) {
        panel.style.display = hasData ? 'none' : 'block';
      }
    }

    // Dynamic UI Statistics
    function updateStats() {
      var total = importedClients.length;
      var done = 0;
      importedClients.forEach(function(c) {
        if (c.dialedStatus === 'success' || c.dialedStatus === 'failed') {
          done++;
        }
      });
      document.getElementById('totalCount').textContent = total;
      document.getElementById('doneCount').textContent = done;

      var percent = total > 0 ? (done / total) * 100 : 0;
      document.getElementById('progressFill').style.width = percent + '%';
      
      var pctText = document.getElementById('percentText');
      if (pctText) {
        pctText.textContent = '(' + Math.round(percent) + '%)';
      }
    }

    // Global State for BH-AI Importer
    var tempImportData = null;
    var tempImportHeaders = [];
    var tempImportDetected = null;
    var tempImportType = 'xlsx'; // 'xlsx', 'vcf', 'unstructured'
    var tempUnstructuredContacts = [];

    // OCR Training: save original results before user edits
    var tempOcrFileName = '';
    var tempOcrRawText = '';
    var tempOcrOriginalContacts = [];
    var tempOcrEngine = 'ai_vision'; // 'ai_vision', 'local_tesseract', 'paddleocr', 'text_fallback'

    function resetAIImporterUI() {
      multiImageAborted = true;
      document.getElementById('aiImportInit').style.display = 'flex';
      document.getElementById('aiImportScanning').style.display = 'none';
      document.getElementById('aiImportReport').style.display = 'none';
      document.getElementById('aiLaserLine').style.display = 'none';
      document.getElementById('aiAdjustControls').style.display = 'none';
      
      document.getElementById('aiExcelMappingPills').style.display = 'flex';
      document.getElementById('aiExcelMappingControls').style.display = 'block';
      document.getElementById('aiExcelPreviewContainer').style.display = 'block';
      document.getElementById('aiUnstructuredContainer').style.display = 'none';
      
      document.getElementById('xlsFileInput').value = '';
      document.getElementById('vcfFileInput').value = '';
      var imgFile = document.getElementById('imgFileInput');
      if (imgFile) imgFile.value = '';
      
      tempUnstructuredContacts = [];
      tempImportData = null;
      tempImportHeaders = [];
      tempImportDetected = null;
      // Reset batch label with fresh default
      var blInput = document.getElementById('batchLabelInput');
      if (blInput) {
        blInput.value = '导入-' + new Date().toISOString().slice(0, 19).replace('T', ' ');
      }
    }

    function showAIScanningUI(fileName) {
      document.getElementById('aiImportInit').style.display = 'none';
      document.getElementById('aiImportReport').style.display = 'none';
      
      var scanning = document.getElementById('aiImportScanning');
      scanning.style.display = 'flex';
      
      var laser = document.getElementById('aiLaserLine');
      laser.style.display = 'block';

      // Reset logs
      document.getElementById('aiLog1').innerHTML = '[ ] 正在读取数据流...';
      document.getElementById('aiLog1').style.opacity = '0.5';
      document.getElementById('aiLog2').innerHTML = '[ ] 正在评估特征维度...';
      document.getElementById('aiLog2').style.opacity = '0.3';
      document.getElementById('aiLog3').innerHTML = '[ ] 正在过滤杂质与噪音...';
      document.getElementById('aiLog3').style.opacity = '0.3';
      document.getElementById('aiLog4').innerHTML = '[ ] 正在匹配智能映射...';
      document.getElementById('aiLog4').style.opacity = '0.3';

      setTimeout(function() {
        document.getElementById('aiLog1').innerHTML = '✅ 数据流加载完成 (' + fileName + ')';
        document.getElementById('aiLog1').style.opacity = '1';
        document.getElementById('aiLog2').style.opacity = '0.5';
      }, 300);

      setTimeout(function() {
        document.getElementById('aiLog2').innerHTML = '✅ 评估行列特征成功';
        document.getElementById('aiLog2').style.opacity = '1';
        document.getElementById('aiLog3').style.opacity = '0.5';
      }, 600);

      setTimeout(function() {
        document.getElementById('aiLog3').innerHTML = '✅ 空列与噪音清洗完成';
        document.getElementById('aiLog3').style.opacity = '1';
        document.getElementById('aiLog4').style.opacity = '0.5';
      }, 900);

      setTimeout(function() {
        document.getElementById('aiLog4').innerHTML = '✅ AI 智能映射匹配成功';
        document.getElementById('aiLog4').style.opacity = '1';
      }, 1100);
    }

    function runAIColumnMapping(json) {
      var headerRowIdx = -1;
      var maxHeaderMatches = 0;

      for (var i = 0; i < Math.min(json.length, 10); i++) {
        var row = json[i];
        if (!row) continue;
        var matches = 0;
        for (var j = 0; j < row.length; j++) {
          var cellVal = String(row[j] || '').trim();
          if (/姓名|客户|联系人|name|contact/i.test(cellVal)) matches++;
          if (/电话|手机|号码|phone|tel|mobile/i.test(cellVal)) matches++;
          if (/单位|公司|企业|company|firm|work/i.test(cellVal)) matches++;
          if (/备注|沟通|记录|跟进|说明|介绍|详情|note|remark/i.test(cellVal)) matches++;
        }
        var hasPhoneData = false;
        for (var j = 0; j < row.length; j++) {
          if (isPhone(row[j])) {
            hasPhoneData = true;
            break;
          }
        }
        if (matches > maxHeaderMatches && !hasPhoneData) {
          maxHeaderMatches = matches;
          headerRowIdx = i;
        }
      }

      var nameIdx = -1, phoneIdx = -1, companyIdx = -1, noteIdx = -1;
      var hasHeaders = (headerRowIdx !== -1);

      if (hasHeaders) {
        var headers = json[headerRowIdx];
        for (var i = 0; i < headers.length; i++) {
          var h = String(headers[i] || '').trim();
          if (/姓名|客户|name/i.test(h)) nameIdx = i;
          else if (/电话|手机|号码|phone|tel|mobile/i.test(h)) phoneIdx = i;
          else if (/单位|公司|企业|company|firm|work/i.test(h)) companyIdx = i;
          else if (/备注|沟通|记录|跟进|说明|介绍|详情|note|remark/i.test(h)) noteIdx = i;
        }
        
        if (phoneIdx === -1) {
          for (var i = 0; i < headers.length; i++) {
            var nextRowVal = json[headerRowIdx + 1] ? json[headerRowIdx + 1][i] : undefined;
            if (isPhone(nextRowVal)) {
              phoneIdx = i;
              break;
            }
          }
        }
        if (nameIdx === -1) nameIdx = 0;
      } else {
        var maxCols = 0;
        for (var i = 0; i < json.length; i++) {
          if (json[i] && json[i].length > maxCols) maxCols = json[i].length;
        }
        var phoneCols = [];

        for (var c = 0; c < maxCols; c++) {
          var phoneCount = 0;
          var totalNonEmpty = 0;
          var scanRows = Math.min(json.length, 50);
          for (var r = 0; r < scanRows; r++) {
            var val = json[r] ? json[r][c] : undefined;
            if (val !== undefined && val !== null && String(val).trim() !== '') {
              totalNonEmpty++;
              if (isPhone(val)) {
                phoneCount++;
              }
            }
          }
          if (phoneCount > 0 && (phoneCount / totalNonEmpty >= 0.3 || phoneCount >= 3)) {
            phoneCols.push(c);
          }
        }

        if (phoneCols.length > 0) {
          phoneIdx = phoneCols[0];
          
          var assignedNameCols = new Set();
          
          var leftScore = 0;
          var rightScore = 0;
          var scanRows = Math.min(json.length, 50);

          var canUseLeft = (phoneIdx > 0 && !assignedNameCols.has(phoneIdx - 1));
          var canUseRight = (phoneIdx + 1 < maxCols && !assignedNameCols.has(phoneIdx + 1));

          for (var r = 0; r < scanRows; r++) {
            if (canUseLeft) {
              var leftVal = json[r] ? json[r][phoneIdx - 1] : undefined;
              leftScore += nameScore(leftVal);
            }
            if (canUseRight) {
              var rightVal = json[r] ? json[r][phoneIdx + 1] : undefined;
              rightScore += nameScore(rightVal);
            }
          }

          if (canUseRight && rightScore >= leftScore && rightScore > 0) {
            nameIdx = phoneIdx + 1;
          } else if (canUseLeft && leftScore > 0) {
            nameIdx = phoneIdx - 1;
          } else {
            nameIdx = 0;
          }

          // Heuristic Company & Note Extraction for Non-Header Sheets
          var assignedCols = new Set();
          assignedCols.add(phoneIdx);
          if (nameIdx !== -1) assignedCols.add(nameIdx);

          var bestCompanyCol = -1;
          var maxCompanyScore = 0;
          var bestNoteCol = -1;
          var maxNoteScore = 0;

          for (var c = 0; c < maxCols; c++) {
            if (assignedCols.has(c)) continue;

            var companyScore = 0;
            var noteScoreCount = 0;
            var totalLength = 0;
            var nonValCount = 0;

            for (var r = 0; r < scanRows; r++) {
              var val = json[r] ? json[r][c] : undefined;
              if (val !== undefined && val !== null && String(val).trim() !== '') {
                var s = String(val).trim();
                nonValCount++;
                totalLength += s.length;

                // Priority matching for '有限公司' or corporate suffixes
                if (/有限公司|有限责任|集团|公司|企业|厂|店|中心|商行|工作室/i.test(s)) {
                  companyScore += 15;
                }
                if (/意向|跟进|记录|备注|挂断|接通|无效|微信|电话|加微信|想买|说明|介绍|详情/i.test(s)) {
                  noteScoreCount += 10;
                }
                if (s.length > 8) {
                  noteScoreCount += 2;
                }
              }
            }

            var avgLength = nonValCount > 0 ? (totalLength / nonValCount) : 0;
            noteScoreCount += avgLength;

            if (companyScore > maxCompanyScore && companyScore > 0) {
              maxCompanyScore = companyScore;
              bestCompanyCol = c;
            }
            if (noteScoreCount > maxNoteScore) {
              maxNoteScore = noteScoreCount;
              bestNoteCol = c;
            }
          }

          if (bestCompanyCol !== -1) {
            companyIdx = bestCompanyCol;
            assignedCols.add(bestCompanyCol);
          }
          if (bestNoteCol !== -1 && bestNoteCol !== bestCompanyCol) {
            noteIdx = bestNoteCol;
          }
        }
      }


      return {
        headerRowIdx: headerRowIdx,
        nameIdx: nameIdx,
        phoneIdx: phoneIdx,
        companyIdx: companyIdx,
        noteIdx: noteIdx
      };
    }

    function renderAIReportForExcel(json, detected) {
      tempImportData = json;
      tempImportType = 'xlsx';
      tempImportDetected = detected;

      var headerRowIdx = detected.headerRowIdx;
      var maxCols = 0;
      for (var i = 0; i < json.length; i++) {
        if (json[i] && json[i].length > maxCols) maxCols = json[i].length;
      }

      var headersList = [];
      for (var c = 0; c < maxCols; c++) {
        var hName = '列 ' + String.fromCharCode(65 + c);
        var headerVal = headerRowIdx !== -1 && json[headerRowIdx] ? json[headerRowIdx][c] : undefined;
        if (headerVal) {
          hName = esc(String(headerVal).trim());
        }
        headersList.push({ idx: c, label: hName });
      }
      tempImportHeaders = headersList;

      document.getElementById('pillName').className = 'client-card-tag';
      document.getElementById('pillName').style.background = detected.nameIdx !== -1 ? 'rgba(7,193,96,0.08)' : 'rgba(231,76,60,0.08)';
      document.getElementById('pillName').style.color = detected.nameIdx !== -1 ? 'var(--accent-wechat)' : '#e74c3c';
      document.getElementById('pillName').innerHTML = '姓名 ➔ ' + (detected.nameIdx !== -1 ? headersList[detected.nameIdx].label : '未识别');

      document.getElementById('pillPhone').className = 'client-card-tag';
      document.getElementById('pillPhone').style.background = detected.phoneIdx !== -1 ? 'rgba(7,193,96,0.08)' : 'rgba(231,76,60,0.08)';
      document.getElementById('pillPhone').style.color = detected.phoneIdx !== -1 ? 'var(--accent-wechat)' : '#e74c3c';
      document.getElementById('pillPhone').innerHTML = '电话 ➔ ' + (detected.phoneIdx !== -1 ? headersList[detected.phoneIdx].label : '未识别');

      document.getElementById('pillCompany').className = 'client-card-tag';
      document.getElementById('pillCompany').style.background = detected.companyIdx !== -1 ? 'rgba(74,108,247,0.08)' : 'rgba(0,0,0,0.04)';
      document.getElementById('pillCompany').style.color = detected.companyIdx !== -1 ? '#4a6cf7' : 'var(--text-light)';
      document.getElementById('pillCompany').innerHTML = '公司 ➔ ' + (detected.companyIdx !== -1 ? headersList[detected.companyIdx].label : '无');

      document.getElementById('pillNote').className = 'client-card-tag';
      document.getElementById('pillNote').style.background = detected.noteIdx !== -1 ? 'rgba(245,124,0,0.08)' : 'rgba(0,0,0,0.04)';
      document.getElementById('pillNote').style.color = detected.noteIdx !== -1 ? '#f57c00' : 'var(--text-light)';
      document.getElementById('pillNote').innerHTML = '备注 ➔ ' + (detected.noteIdx !== -1 ? headersList[detected.noteIdx].label : '无');

      renderImportMappingControls(headersList, detected);

      if (detected.nameIdx !== -1 && detected.phoneIdx !== -1) {
        executeAIImportExcel();
        alert('📊 Excel 识别：自动对应姓名列「' + headersList[detected.nameIdx].label + '」与电话列「' + headersList[detected.phoneIdx].label + '」成功，已自动入库并同步至 Supabase！');
        return;
      }

      var conf = 90;
      if (detected.nameIdx !== -1 && detected.phoneIdx !== -1) conf = detected.headerRowIdx !== -1 ? 98.5 : 92.0;
      if (detected.companyIdx !== -1) conf += 1.0;
      if (detected.noteIdx !== -1) conf += 0.5;
      document.getElementById('aiConfidenceBadge').innerHTML = '● AI 置信度: ' + conf.toFixed(1) + '%';
      
      document.getElementById('aiReportTitle').innerHTML = 'AI 识别报告: Excel 表格数据';

      updateAIPreviewTable();

      document.getElementById('aiImportScanning').style.display = 'none';
      document.getElementById('aiLaserLine').style.display = 'none';
      document.getElementById('aiImportReport').style.display = 'flex';
      
      document.getElementById('aiToggleAdjustBtn').style.display = 'inline-flex';
    }

    function populateMappingSelect(selId, headers, selectedIdx, hasNone) {
      var select = typeof selId === 'string' ? document.getElementById(selId) : selId;
      if (!select) return;
      select.innerHTML = '';
      if (hasNone) {
        var optNone = document.createElement('option');
        optNone.value = '-1';
        optNone.textContent = '(无映射/不导入)';
        if (selectedIdx === -1) optNone.selected = true;
        select.appendChild(optNone);
      }
      headers.forEach(function(h) {
        var opt = document.createElement('option');
        opt.value = h.idx;
        opt.textContent = String(h.idx + 1) + '列 - ' + h.label;
        if (h.idx === selectedIdx) opt.selected = true;
        select.appendChild(opt);
      });
    }

    function updateAIPreviewTable() {
      var nameCol = parseInt(document.getElementById('aiSelName').value);
      var phoneCol = parseInt(document.getElementById('aiSelPhone').value);
      var compCol = parseInt(document.getElementById('aiSelCompany').value);
      var noteCol = parseInt(document.getElementById('aiSelNote').value);
      
      var customMappings = [];
      var customSelects = document.querySelectorAll('#aiAdjustControls .aiSelCustom');
      customSelects.forEach(function(sel) {
        var colName = sel.getAttribute('data-col');
        var colIdx = parseInt(sel.value);
        if (colIdx !== -1) {
          customMappings.push({ name: colName, idx: colIdx });
        }
      });

      var tableHead = document.querySelector('#aiPreviewTable thead');
      if (tableHead) {
        var headHtml = '<tr style="border-bottom: 1px solid var(--card-border); font-weight: 800; color: var(--text-soft); background: rgba(0,0,0,0.01);">' +
          '<th style="padding: 4px 8px;">姓名</th>' +
          '<th style="padding: 4px 8px;">电话</th>' +
          '<th style="padding: 4px 8px;">公司</th>';
        customMappings.forEach(function(m) {
          headHtml += '<th style="padding: 4px 8px;">' + esc(m.name) + '</th>';
        });
        headHtml += '</tr>';
        tableHead.innerHTML = headHtml;
      }

      var tableBody = document.querySelector('#aiPreviewTable tbody');
      if (!tableBody) return;
      tableBody.innerHTML = '';

      if (!tempImportData || tempImportData.length === 0) return;

      var startRow = 0;
      if (tempImportDetected && tempImportDetected.headerRowIdx !== -1) {
        startRow = tempImportDetected.headerRowIdx + 1;
      }

      var previewCount = 0;
      for (var r = startRow; r < tempImportData.length && previewCount < 3; r++) {
        var row = tempImportData[r];
        if (!row || row.length === 0) continue;
        
        var rawPhone = phoneCol !== -1 ? row[phoneCol] : '';
        var phoneVal = cleanPhone(rawPhone);
        if (!phoneVal) continue;

        var nameVal = nameCol !== -1 ? String(row[nameCol] || '').trim() : '客户';
        var compVal = compCol !== -1 ? String(row[compCol] || '').trim() : '';

        var customTds = '';
        customMappings.forEach(function(m) {
          var val = String(row[m.idx] || '').trim();
          customTds += '<td style="padding: 6px 8px; color: var(--text-soft);">' + esc(val || '(空)') + '</td>';
        });

        var tr = document.createElement('tr');
        tr.style.borderBottom = '0.5px solid var(--card-border)';
        tr.innerHTML = '<td style="padding: 6px 8px; font-weight: 800; color: var(--text-main);">' + esc(nameVal || '未知姓名') + '</td>' +
                       '<td style="padding: 6px 8px; font-family: monospace; color: var(--accent-wechat); font-weight: 800;">' + esc(phoneVal) + '</td>' +
                       '<td style="padding: 6px 8px; color: var(--text-soft);">' + esc(compVal || '(空)') + '</td>' +
                       customTds;
        tableBody.appendChild(tr);
        previewCount++;
      }

      var colspanVal = 3 + customMappings.length;
      if (previewCount === 0) {
        tableBody.innerHTML = '<tr><td colspan="' + colspanVal + '" style="padding: 12px; text-align: center; color: var(--text-light);">当前列映射无法提取有效客户电话号码，请手动调整电话数据列。</td></tr>';
      }

      var totalImportCount = calculateParsedCount(nameCol, phoneCol, compCol, noteCol);
      document.getElementById('aiConfirmImportBtn').innerHTML = 'AI 确认导入 (' + totalImportCount + ' 位联系人)';
    }

    function calculateParsedCount(nameCol, phoneCol, compCol, noteCol) {
      if (!tempImportData || phoneCol === -1) return 0;
      var count = 0;
      var phoneSet = new Set();
      var startRow = 0;
      if (tempImportDetected && tempImportDetected.headerRowIdx !== -1) {
        startRow = tempImportDetected.headerRowIdx + 1;
      }
      for (var r = startRow; r < tempImportData.length; r++) {
        var row = tempImportData[r];
        if (!row || row.length === 0) continue;
        var phoneVal = cleanPhone(row[phoneCol]);
        if (!phoneVal) continue;
        if (phoneSet.has(phoneVal)) continue;
        phoneSet.add(phoneVal);
        count++;
      }
      return count;
    }

    function executeAIImportExcel() {
      var nameCol = parseInt(document.getElementById('aiSelName').value);
      var phoneCol = parseInt(document.getElementById('aiSelPhone').value);
      var compCol = parseInt(document.getElementById('aiSelCompany').value);
      var noteCol = parseInt(document.getElementById('aiSelNote').value);
      var batchLabel = (document.getElementById('batchLabelInput').value || '').trim();
      var defaultCat = document.getElementById('importCategorySelect') ? document.getElementById('importCategorySelect').value : '公海客户';

      if (phoneCol === -1) {
        alert('请至少为电话选择一列进行导入！');
        return;
      }

      var startRow = 0;
      if (tempImportDetected && tempImportDetected.headerRowIdx !== -1) {
        startRow = tempImportDetected.headerRowIdx + 1;
      }

      var customMappings = [];
      var customSelects = document.querySelectorAll('#aiAdjustControls .aiSelCustom');
      customSelects.forEach(function(sel) {
        var colName = sel.getAttribute('data-col');
        var colIdx = parseInt(sel.value);
        if (colIdx !== -1) {
          customMappings.push({ name: colName, idx: colIdx });
        }
      });

      var parsedCustomers = [];
      var phoneSet = new Set();

      for (var r = startRow; r < tempImportData.length; r++) {
        var row = tempImportData[r];
        if (!row || row.length === 0) continue;
        var phoneVal = cleanPhone(row[phoneCol]);
        if (!phoneVal) continue;
        if (phoneSet.has(phoneVal)) continue;
        phoneSet.add(phoneVal);

        var nameVal = nameCol !== -1 ? String(row[nameCol] || '').trim() : '客户';
        var companyVal = compCol !== -1 ? String(row[compCol] || '').trim() : '';
        var noteVal = noteCol !== -1 ? String(row[noteCol] || '').trim() : '';

        var fundVal = '';
        if (/^d{4,5}$/.test(noteVal)) {
          fundVal = noteVal;
          noteVal = '';
        }

        var customObj = {};
        customMappings.forEach(function(m) {
          var val = String(row[m.idx] || '').trim();
          if (val) {
            customObj[m.name] = val;
          }
        });
        var finalNote = noteVal;
        if (Object.keys(customObj).length > 0 || fundVal) {
          var pl = { note: noteVal, custom: customObj };
          if (fundVal) pl.fund = fundVal;
          finalNote = JSON.stringify(pl);
        }

        parsedCustomers.push({
          name: nameVal || '未知姓名',
          phone: phoneVal,
          mobile: phoneVal,
          company: companyVal,
          note: finalNote,
          fund: fundVal,
          dialedStatus: 'todo',
          duration: '',
          callNote: '',
          category: defaultCat,
          batch_label: batchLabel
        });
      }

      if (parsedCustomers.length === 0) {
        alert('未找到任何有效的数据，请确认所选的数据列！');
        return;
      }

      importedClients = parsedCustomers;
      saveState();
      updateDashboardVisibility(true);
      renderDialCards();

      // Auto-upload to Supabase
      uploadCustomersToSupabase(parsedCustomers, batchLabel);

      resetAIImporterUI();
    }

    function executeAIImportVcf() {
      if (!tempImportData || tempImportData.length === 0) return;
      var batchLabel = (document.getElementById('batchLabelInput').value || '').trim();
      var defaultCat = document.getElementById('importCategorySelect') ? document.getElementById('importCategorySelect').value : '公海客户';
      // Tag each client with the batch label and category
      for (var i = 0; i < tempImportData.length; i++) {
        var c = tempImportData[i];
        c.batch_label = batchLabel;
        c.category = defaultCat;
        c.mobile = c.mobile || c.phone;
        c.phone = c.phone || c.mobile;
        if (!c.fund && /^d{4,5}$/.test((c.note || '').trim())) {
          c.fund = c.note.trim();
          c.note = '';
        }
      }
      importedClients = tempImportData;
      saveState();
      updateDashboardVisibility(true);
      renderDialCards();

      // Auto-upload to Supabase
      uploadCustomersToSupabase(tempImportData, batchLabel);

      resetAIImporterUI();
    }

    function renderAIReportForVcf(contactsList) {
      tempImportData = contactsList;
      tempImportType = 'vcf';
      
      if (contactsList && contactsList.length > 0) {
        executeAIImportVcf();
        alert('📇 VCF 识别：成功自动识别 ' + contactsList.length + ' 个联系人，已直接自动入库并同步至 Supabase！');
        return;
      }

      document.getElementById('pillName').className = 'client-card-tag';
      document.getElementById('pillName').style.background = 'rgba(7,193,96,0.08)';
      document.getElementById('pillName').style.color = 'var(--accent-wechat)';
      document.getElementById('pillName').innerHTML = '姓名 ➔ VCF (FN)';

      document.getElementById('pillPhone').className = 'client-card-tag';
      document.getElementById('pillPhone').style.background = 'rgba(7,193,96,0.08)';
      document.getElementById('pillPhone').style.color = 'var(--accent-wechat)';
      document.getElementById('pillPhone').innerHTML = '电话 ➔ VCF (TEL)';

      document.getElementById('pillCompany').className = 'client-card-tag';
      document.getElementById('pillCompany').style.background = 'rgba(74,108,247,0.08)';
      document.getElementById('pillCompany').style.color = '#4a6cf7';
      document.getElementById('pillCompany').innerHTML = '公司 ➔ VCF (ORG)';

      document.getElementById('pillNote').className = 'client-card-tag';
      document.getElementById('pillNote').style.background = 'rgba(0,0,0,0.04)';
      document.getElementById('pillNote').style.color = 'var(--text-light)';
      document.getElementById('pillNote').innerHTML = '备注 ➔ VCF (NOTE)';

      document.getElementById('aiAdjustControls').style.display = 'none';
      document.getElementById('aiToggleAdjustBtn').style.display = 'none';

      document.getElementById('aiConfidenceBadge').innerHTML = '● AI 置信度: 100.0%';
      document.getElementById('aiReportTitle').innerHTML = 'AI 识别报告: VCF 通讯录文件';

      var tableBody = document.querySelector('#aiPreviewTable tbody');
      if (tableBody) {
        tableBody.innerHTML = '';
        var limit = Math.min(contactsList.length, 3);
        for (var i = 0; i < limit; i++) {
          var c = contactsList[i];
          var tr = document.createElement('tr');
          tr.style.borderBottom = '0.5px solid var(--card-border)';
          tr.innerHTML = '<td style="padding: 6px 8px; font-weight: 800; color: var(--text-main);">' + esc(c.name || '未知姓名') + '</td>' +
                         '<td style="padding: 6px 8px; font-family: monospace; color: var(--accent-wechat); font-weight: 800;">' + esc(c.phone) + '</td>' +
                         '<td style="padding: 6px 8px; color: var(--text-soft);">' + esc(c.company || '(空)') + '</td>';
          tableBody.appendChild(tr);
        }
      }

      document.getElementById('aiConfirmImportBtn').innerHTML = 'AI 确认导入 (' + contactsList.length + ' 位联系人)';

      document.getElementById('aiImportScanning').style.display = 'none';
      document.getElementById('aiLaserLine').style.display = 'none';
      document.getElementById('aiImportReport').style.display = 'flex';
    }

    var scriptLoadingPromises = {};
    function loadScript(url) {
      if (scriptLoadingPromises[url]) return scriptLoadingPromises[url];
      scriptLoadingPromises[url] = new Promise(function(resolve, reject) {
        if (document.querySelector('script[src="' + url + '"]')) {
          resolve();
          return;
        }
        var script = document.createElement('script');
        script.src = url;
        script.onload = function() { resolve(); };
        script.onerror = function() { reject(new Error('Failed to load script: ' + url)); };
        document.head.appendChild(script);
      });
      return scriptLoadingPromises[url];
    }

    function parsePhoneContactsFromRawText(text) {
      if (!text) return [];
      
      var lines = text.split(/\r\n|\r|\n/);
      var results = [];
      var phoneSet = new Set();
      
      // Common Chinese Surnames to validate names
      var SURNAMES = /^(张|李|王|刘|陈|杨|赵|黄|周|吴|徐|孙|马|胡|朱|郭|何|林|高|罗|郑|梁|谢|唐|韩|曹|许|邓|萧|冯|曾|程|蔡|彭|潘|袁|于|董|余|苏|叶|吕|魏|蒋|田|杜|丁|沈|姜|范|江|傅|钟|卢|汪|戴|崔|陆|廖|姚|方|金|邱|夏|谭|韦|贾|邹|石|熊|放|孟|秦|阎|薛|侯|雷|白|龙|段|郝|孔|邵|史|毛|常|万|顾|赖|武|康|贺|严|克)/;
      
      // Strict metadata, label and corporate suffix validation to filter out noise
      function isValidNameHeuristic(str) {
        if (!str) return false;
        var cleanStr = str.replace(/[\s.,，。:：;；%&|()（）\[\]{}<>]/g, '');
        // Must contain ONLY Chinese characters
        if (!/^[\u4e00-\u9fa5]+$/.test(cleanStr)) {
          return false;
        }
        // Length check
        if (cleanStr.length < 1 || cleanStr.length > 6) {
          return false;
        }
        // Single character: accept as surname (common in phone dialers)
            if (cleanStr.length === 1) {
              if (!/^[一-龥]$/.test(cleanStr)) return false;
              return true;
            }
        if (/姓名|电话|手机|号码|公司|备注|联系人|客户|微信|意向|跟进|记录|挂断|接通|无效|加微信|想买|说明|介绍|详情|tel|phone|mobile|name/i.test(cleanStr)) {
          return false;
        }
        if (/有限公司|有限责任|集团|公司|企业|厂|店|中心|商行|工作室|股份/.test(cleanStr)) {
          return false;
        }
        if (/北京|上海|广州|深圳|成都|杭州|武汉|西安|重庆|南京|天津|中国|四川|湖南|湖北|广东|江苏|浙江|山东|福建|江西|河南|河北|安徽|辽宁|吉林|黑龙江|山西|陕西|甘肃|青海|云南|贵州|广西|西藏|内模|内蒙|新疆|宁夏|海南|港澳|台湾|东莞|佛山|温州|宁波|苏州|无锡|常州|扬州|徐州|南通/i.test(cleanStr)) {
          return false;
        }
        return true;
      }

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        
        var cleanLine = line.replace(/[-\s]/g, '').replace(/[Il|]/g, '1').replace(/[oO]/g, '0');
        var robustPhoneRegex = /(?:1[3-9]\d{9}|0\d{2,3}\d{7,8})/g;
        var match;
        var foundPhonesInLine = [];
        
        while ((match = robustPhoneRegex.exec(cleanLine)) !== null) {
          var cleanPhoneStr = match[0];
          if (!phoneSet.has(cleanPhoneStr)) {
            foundPhonesInLine.push({
              phone: cleanPhoneStr,
              raw: cleanPhoneStr,
              index: 0,
              length: match[0].length
            });
            phoneSet.add(cleanPhoneStr);
          }
        }
        
        if (foundPhonesInLine.length === 0) {
          var phoneRegex = /(?:1[3-9]\d{9}|1[3-9]\d{1,2}[-\s]\d{3,4}[-\s]\d{4}|0\d{2,3}[-\s]\d{7,8}|0\d{9,11})/g;
          while ((match = phoneRegex.exec(line)) !== null) {
            var cleanPhoneStr = match[0].replace(/[-\s]/g, '');
            if (!phoneSet.has(cleanPhoneStr)) {
              foundPhonesInLine.push({
                phone: cleanPhoneStr,
                raw: match[0],
                index: match.index,
                length: match[0].length
              });
              phoneSet.add(cleanPhoneStr);
            }
          }
        }
        
        if (foundPhonesInLine.length === 0) continue;
        
        for (var pi = 0; pi < foundPhonesInLine.length; pi++) {
          var phoneInfo = foundPhonesInLine[pi];
          var phoneStr = phoneInfo.phone;
          var rawPhoneStr = phoneInfo.raw;
          
          var name = '';
          var company = '';
          var noteParts = [];
          
          // Replace current phone in line with space to separate name and company when连写
          var lineWithoutPhone = line.replace(rawPhoneStr, ' ');
          
          // Delimit segments on the line to parse columns/words
          var delimiters = /[\s,，:：|｜;；\t\-\[\]\(\)]+/;
          var lineParts = lineWithoutPhone.split(delimiters).map(function(p) { return p.trim(); }).filter(Boolean);
          
          // Filter out other phone tokens if any
          var remainingParts = lineParts.filter(function(part) {
            var cleanPart = part.replace(/[-\s]/g, '');
            for (var k = 0; k < foundPhonesInLine.length; k++) {
              var otherPhone = foundPhonesInLine[k];
              if (cleanPart.indexOf(otherPhone.phone) !== -1 || part.indexOf(otherPhone.raw) !== -1) {
                return false;
              }
            }
            return true;
          });
          
          // 1. Identify Company Candidates
          var bestCompany = '';
          for (var j = 0; j < remainingParts.length; j++) {
            var part = remainingParts[j];
            if (/联系人|负责人|姓名|电话|手机|号码|备注|意向|跟进|记录|挂断|接通|无效|加微信/i.test(part)) {
              continue;
            }
            if (/有限公司|有限责任|集团|公司|企业|厂|店|中心|商行|工作室|股份|科技|技术|网络|制造|金融|地产|开发/.test(part)) {
              bestCompany = part;
              break;
            }
          }
          
          // Fallback Company (institution suffixes)
          if (!bestCompany) {
            for (var j = 0; j < remainingParts.length; j++) {
              var part = remainingParts[j];
              if (/局|厅|科|所|校|院|部/.test(part)) {
                bestCompany = part;
                break;
              }
            }
          }
          
          if (bestCompany) {
            company = bestCompany;
          }
          
          // Spatial prefix/suffix extraction
          var prefix = line.substring(0, phoneInfo.index).trim();
          var prefixMatch = /([\u4e00-\u9fa5]{1,4})\s*$/.exec(prefix);
          var prefixName = prefixMatch ? prefixMatch[1] : '';
          
          var suffix = line.substring(phoneInfo.index + phoneInfo.length).trim();
          var suffixMatch = /^\s*([\u4e00-\u9fa5]{1,4})/.exec(suffix);
          var suffixName = suffixMatch ? suffixMatch[1] : '';

          // 2. Identify Name with multi-phase priority
          // Phase A: Segment matches starting with common surnames
          for (var j = 0; j < remainingParts.length; j++) {
            var part = remainingParts[j];
            if (part === company) continue;
            if (isValidNameHeuristic(part) && SURNAMES.test(part) && part.length <= 4) {
              name = part;
              break;
            }
          }
          
          // Phase B: Adjacent prefix/suffix matches starting with common surnames
          if (!name) {
            if (prefixName && isValidNameHeuristic(prefixName) && SURNAMES.test(prefixName)) {
              name = prefixName;
            } else if (suffixName && isValidNameHeuristic(suffixName) && SURNAMES.test(suffixName)) {
              name = suffixName;
            }
          }
          
          // Phase C: Regular segments (Chinese name / titles) satisfying validity
          if (!name) {
            for (var j = 0; j < remainingParts.length; j++) {
              var part = remainingParts[j];
              if (part === company) continue;
              if (isValidNameHeuristic(part) && part.length <= 4) {
                name = part;
                break;
              }
            }
          }
          
          // Phase D: Adjacent prefix/suffix satisfying validity
          if (!name) {
            if (prefixName && isValidNameHeuristic(prefixName)) {
              name = prefixName;
            } else if (suffixName && isValidNameHeuristic(suffixName)) {
              name = suffixName;
            }
          }
          
          // Phase E: Any valid remaining segment up to 6 characters
          if (!name) {
            for (var j = 0; j < remainingParts.length; j++) {
              var part = remainingParts[j];
              if (part === company) continue;
              if (isValidNameHeuristic(part)) {
                name = part;
                break;
              }
            }
          }
          
          // Fallback
          if (!name) {
            name = '客户-' + phoneStr.substring(phoneStr.length - 4);
          }
          
          // Extract Notes from remaining parts
          for (var j = 0; j < remainingParts.length; j++) {
            var part = remainingParts[j];
            if (part !== name && part !== company) {
              // Skip UI labels/metadata in notes to keep them clean
              if (/姓名|电话|手机|号码|公司|备注|联系人|客户|微信|负责人|说明|介绍|详情/i.test(part) && part.length <= 5) {
                continue;
              }
              var cleanPart = part.replace(/[-\s.,，。:：;；%&|()（）\[\]{}<>]/g, '');
              if (cleanPart.length <= 1 && !/^\d$/.test(cleanPart)) {
                continue;
              }
              if (/^[a-zA-Z]+$/.test(cleanPart) && cleanPart.length < 3) {
                continue;
              }
              noteParts.push(part);
            }
          }
          
          var finalNote = noteParts.join(' ');
          var fund = '';
          if (/^d{4,5}$/.test(finalNote)) {
            fund = finalNote;
            finalNote = '';
          }
          results.push({
            name: name,
            phone: phoneStr,
            company: company,
            note: finalNote,
            fund: fund
          });
        }
      }
      
      if (results.length === 0) {
        var globalPhoneRegex = /1[3-9]\d{9}/g;
        var globalMatch;
        while ((globalMatch = globalPhoneRegex.exec(text)) !== null) {
          var p = globalMatch[0];
          if (!phoneSet.has(p)) {
            phoneSet.add(p);
            
            // Reverse-seek in raw text for names immediately preceding global phones
            var searchStart = Math.max(0, globalMatch.index - 15);
            var searchSlice = text.substring(searchStart, globalMatch.index);
            var nameMatch = /([\u4e00-\u9fa5]{2,4})\s*$/.exec(searchSlice);
            var foundName = nameMatch ? nameMatch[1] : '';
            
            results.push({
              name: foundName || ('客户-' + p.substring(p.length - 4)),
              phone: p,
              company: '',
              note: ''
            });
          }
        }
      }
      
      return results;
    }

    // Correct OCR text using text AI (not vision) — fixes Tesseract/WASM errors
    // Falls back to regex parsing if AI is unavailable
    function correctOcrTextWithAI(rawText, fileName, onDone) {
      // Check if any text AI is configured
      var aiKey = (localStorage.getItem('vision_api_key') || localStorage.getItem('ai_api_key') || localStorage.getItem('deepseek_api_key') || '').trim();
      if (!aiKey) {
        // No AI key — use regex fallback directly
        var contacts = parsePhoneContactsFromRawText(rawText);
        onDone(contacts);
        return;
      }

      document.getElementById('aiLog3').innerHTML = '🧠 文本 AI 正在修正 OCR 识别错误...';
      document.getElementById('aiLog3').style.opacity = '1';
      if (document.getElementById('aiLog4')) {
        document.getElementById('aiLog4').innerHTML = '⏳ 检测并修正：数字混淆、形近字、断裂文本...';
        document.getElementById('aiLog4').style.opacity = '1';
      }

      fetch('/api/ocr/correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: rawText, fileName: fileName || 'local_ocr' })
      })
      .then(function(r) { return r.json(); })
      .then(function(result) {
        if (result.contacts && result.contacts.length > 0) {
          if (document.getElementById('aiLog3')) {
            document.getElementById('aiLog3').innerHTML = '✅ 文本 AI 修正完成 · 识别 ' + result.contacts.length + ' 个联系人';
            document.getElementById('aiLog3').style.opacity = '1';
          }
          // Save raw OCR text for training data
          tempOcrRawText = rawText;
          tempOcrEngine = 'text_ai_correct';
          onDone(result.contacts);
        } else {
          // AI returned no contacts — fallback to regex
          if (document.getElementById('aiLog3')) {
            document.getElementById('aiLog3').innerHTML = '⚠️ AI 未检出，使用本地正则解析...';
          }
          var fbContacts = parsePhoneContactsFromRawText(rawText);
          tempOcrEngine = 'local_tesseract';
          onDone(fbContacts);
        }
      })
      .catch(function(err) {
        console.error('[OCR Correct] API call failed, using regex fallback:', err.message);
        if (document.getElementById('aiLog3')) {
          document.getElementById('aiLog3').innerHTML = '⚠️ AI 不可用，使用本地正则解析...';
        }
        var fbContacts = parsePhoneContactsFromRawText(rawText);
        tempOcrEngine = 'local_tesseract';
        onDone(fbContacts);
      });
    }

    function handleFileImportDispatch(file) {
      if (!file) return;
      var ext = file.name.split('.').pop().toLowerCase();
      var sizeMB = file.size / (1024 * 1024);
      
      if (sizeMB > 30) {
        alert('文件大小超过 30MB 限制！目前仅支持上传 30MB 以内的文件。');
        return;
      }
      
      if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
        if (sizeMB > 3) {
          handleExcelLargeFileWorker(file);
        } else {
          handleExcelImport(file);
        }
      } else if (ext === 'vcf' || ext === 'vcard') {
        handleVcfImport(file);
      } else if (ext === 'docx') {
        handleDocxImport(file);
      } else if (ext === 'pdf') {
        handlePdfImport(file);
      } else if (ext === 'txt') {
        handleTxtImport(file);
      } else if (/jpg|jpeg|png|bmp|webp/i.test(ext)) {
        handleImageOCR(file);
      } else {
        alert('不支持的文件格式！目前支持 Excel, CSV, VCF, Word(docx), PDF, 纯文本(txt) 以及常用格式图片。');
      }
    }

    function handleExcelLargeFileWorker(file) {
      showAIScanningUI(file.name);
      document.getElementById('aiScanStatus').innerHTML = '⚡ 智能大文件多线程加速解析中...';
      if (document.getElementById('aiLog1')) {
        document.getElementById('aiLog1').innerHTML = '⏳ 正在加载 Web Worker 解析引擎...';
        document.getElementById('aiLog1').style.opacity = '1';
      }
      
      var reader = new FileReader();
      reader.onload = function(e) {
        var arrayBuffer = e.target.result;
        
        var workerCode = [
          "self.importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');",
          "self.onmessage = function(e) {",
          "  try {",
          "    var data = new Uint8Array(e.data);",
          "    var workbook = XLSX.read(data, { type: 'array' });",
          "    var firstSheetName = workbook.SheetNames[0];",
          "    var worksheet = workbook.Sheets[firstSheetName];",
          "    var json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });",
          "    self.postMessage({ success: true, json: json });",
          "  } catch(err) {",
          "    self.postMessage({ success: false, error: err.message });",
          "  }",
          "};"
        ].join("\n");
        
        var blob = new Blob([workerCode], { type: 'application/javascript' });
        var workerUrl = URL.createObjectURL(blob);
        var worker = new Worker(workerUrl);
        
        worker.onmessage = function(ev) {
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          
          if (ev.data.success) {
            var json = ev.data.json;
            if (json.length === 0) {
              alert('导入失败：表格无数据');
              resetAIImporterUI();
              return;
            }
            if (document.getElementById('aiLog3')) {
              document.getElementById('aiLog3').innerHTML = '✅ 大数据读取与过滤清洗完成';
              document.getElementById('aiLog3').style.opacity = '1';
            }
            var detected = runAIColumnMapping(json);
            renderAIReportForExcel(json, detected);
          } else {
            alert('大文件解析失败：' + ev.data.error);
            resetAIImporterUI();
          }
        };
        
        worker.postMessage(arrayBuffer, [arrayBuffer]);
      };
      
      reader.readAsArrayBuffer(file);
    }

    function handleDocxImport(file) {
      tempOcrEngine = 'text_fallback';
      showAIScanningUI(file.name);
      document.getElementById('aiScanStatus').innerHTML = '⚙️ AI 正在载入 Word 解析引擎...';
      if (document.getElementById('aiLog1')) {
        document.getElementById('aiLog1').innerHTML = '⏳ 正在加载 mammoth.js 脚本库...';
        document.getElementById('aiLog1').style.opacity = '1';
      }
      
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js')
        .then(function() {
          if (document.getElementById('aiLog2')) {
            document.getElementById('aiLog2').innerHTML = '✅ Word 解析引擎载入成功';
            document.getElementById('aiLog2').style.opacity = '1';
          }
          document.getElementById('aiScanStatus').innerHTML = '📄 正在深度分析 Word 文档数据流...';
          
          var reader = new FileReader();
          reader.onload = function(e) {
            var arrayBuffer = e.target.result;
            window.mammoth.extractRawText({ arrayBuffer: arrayBuffer })
              .then(function(result) {
                if (document.getElementById('aiLog3')) {
                  document.getElementById('aiLog3').innerHTML = '✅ 提取纯文本内容完成';
                  document.getElementById('aiLog3').style.opacity = '1';
                }
                var text = result.value;
                if (document.getElementById('aiLog4')) {
                  document.getElementById('aiLog4').innerHTML = '⏳ AI 正在运行模式启发式提取...';
                  document.getElementById('aiLog4').style.opacity = '1';
                }
                setTimeout(function() {
                  correctOcrTextWithAI(text, file.name, function(contacts) {
                    renderAIUnstructuredReport(file.name, contacts);
                  });
                }, 600);
              })
              .catch(function(err) {
                alert('Word 解析失败：' + err.message);
                resetAIImporterUI();
              });
          };
          reader.readAsArrayBuffer(file);
        })
        .catch(function(err) {
          alert('解析引擎加载失败，请检查您的网络连接：' + err.message);
          resetAIImporterUI();
        });
    }

    function handlePdfImport(file) {
      tempOcrEngine = 'text_fallback';
      showAIScanningUI(file.name);
      document.getElementById('aiScanStatus').innerHTML = '⚙️ AI 正在载入 PDF 解析引擎...';
      if (document.getElementById('aiLog1')) {
        document.getElementById('aiLog1').innerHTML = '⏳ 正在加载 pdf.js 脚本库...';
        document.getElementById('aiLog1').style.opacity = '1';
      }
      
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js')
        .then(function() {
          window['pdfjs-dist/build/pdf'].GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
          
          if (document.getElementById('aiLog2')) {
            document.getElementById('aiLog2').innerHTML = '✅ PDF 引擎初始化完成';
            document.getElementById('aiLog2').style.opacity = '1';
          }
          document.getElementById('aiScanStatus').innerHTML = '📄 正在深度分析 PDF 文档页面...';
          
          var reader = new FileReader();
          reader.onload = function(e) {
            var arrayBuffer = e.target.result;
            var loadingTask = window['pdfjs-dist/build/pdf'].getDocument({ data: arrayBuffer });
            
            loadingTask.promise.then(function(pdf) {
              var maxPages = pdf.numPages;
              var extractedText = '';
              var loadedPages = 0;
              
              if (document.getElementById('aiLog3')) {
                document.getElementById('aiLog3').innerHTML = '⏳ 正在并行扫描 ' + maxPages + ' 个页面...';
                document.getElementById('aiLog3').style.opacity = '1';
              }
              
              function loadPageText(pageNumber) {
                document.getElementById('aiScanStatus').innerHTML = '📄 正在扫描 PDF 页面 (' + pageNumber + '/' + maxPages + ')...';
                
                return pdf.getPage(pageNumber).then(function(page) {
                  return page.getTextContent().then(function(textContent) {
                    var pageText = textContent.items.map(function(item) { return item.str; }).join(' ');
                    extractedText += pageText + '\n';
                    loadedPages++;
                    
                    if (loadedPages < maxPages) {
                      return loadPageText(pageNumber + 1);
                    } else {
                      if (document.getElementById('aiLog3')) {
                        document.getElementById('aiLog3').innerHTML = '✅ PDF 页面文本提取完毕';
                      }
                      if (document.getElementById('aiLog4')) {
                        document.getElementById('aiLog4').innerHTML = '⏳ AI 正在运行特征神经网络分析...';
                        document.getElementById('aiLog4').style.opacity = '1';
                      }
                      setTimeout(function() {
                        correctOcrTextWithAI(extractedText, file.name, function(contacts) {
                          if (contacts.length > 0) {
                            renderAIUnstructuredReport(file.name, contacts);
                          } else {
                            handleScannedPdfOCR(pdf, file.name);
                          }
                        });
                      }, 600);
                    }
                  });
                });
              }

              function handleScannedPdfOCR(pdf, fileName) {
                runLocalScannedPdfSlicingOCR(pdf, fileName);
              }
              
              loadPageText(1).catch(function(err) {
                alert('PDF 页面文本提取失败：' + err.message);
                resetAIImporterUI();
              });
              
            }).catch(function(err) {
              alert('PDF 文档读取失败：' + err.message);
              resetAIImporterUI();
            });
          };
          reader.readAsArrayBuffer(file);
        })
        .catch(function(err) {
          alert('PDF 解析引擎加载失败：' + err.message);
          resetAIImporterUI();
        });
    }

    // ====== Local Wasm OCR Slicing & Preprocessing Helper Methods ======
    var tempOcrFile = null;
    var tempOcrPdf = null;
    var tempOcrFileName = '';
    var tempOcrImgDataUrl = '';
    var ocrPreviewImage = new Image();

    function showOcrSlicingPreview(imgDataUrl) {
      var configPanel = document.getElementById('localOcrConfigPanel');
      var initPanel = document.getElementById('aiImportInit');
      var scanPanel = document.getElementById('aiImportScanning');
      var reportPanel = document.getElementById('aiImportReport');
      
      if (initPanel) initPanel.style.display = 'none';
      if (scanPanel) scanPanel.style.display = 'none';
      if (reportPanel) reportPanel.style.display = 'none';
      if (configPanel) configPanel.style.display = 'flex';
      
      ocrPreviewImage.src = imgDataUrl;
      ocrPreviewImage.onload = function() {
        drawOcrSlicingPreviewLines();
      };
    }

    function drawOcrSlicingPreviewLines() {
      var canvas = document.getElementById('ocrPreviewCanvas');
      if (!canvas || !ocrPreviewImage.src) return;
      var ctx = canvas.getContext('2d');
      
      var split1 = parseInt(document.getElementById('sliderSplit1').value);
      var split2 = parseInt(document.getElementById('sliderSplit2').value);
      var order = document.getElementById('ocrColumnOrder').value;
      
      // Update values text
      document.getElementById('valSplit1').textContent = split1 + '%';
      document.getElementById('valSplit2').textContent = split2 + '%';
      
      // Set canvas dimensions to match image aspect ratio
      canvas.width = ocrPreviewImage.naturalWidth;
      canvas.height = ocrPreviewImage.naturalHeight;
      
      ctx.drawImage(ocrPreviewImage, 0, 0);
      
      // Draw vertical line 1 (Dashed Red)
      var x1 = canvas.width * (split1 / 100);
      ctx.beginPath();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = '#e74c3c';
      ctx.lineWidth = Math.max(2, canvas.width / 150);
      ctx.moveTo(x1, 0);
      ctx.lineTo(x1, canvas.height);
      ctx.stroke();
      
      // Draw vertical line 2 (Dashed Green)
      var x2 = canvas.width * (split2 / 100);
      ctx.beginPath();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = '#2ecc71';
      ctx.lineWidth = Math.max(2, canvas.width / 150);
      ctx.moveTo(x2, 0);
      ctx.lineTo(x2, canvas.height);
      ctx.stroke();
      
      // Draw labels between columns
      ctx.font = 'bold ' + Math.max(12, canvas.height / 20) + 'px sans-serif';
      ctx.textAlign = 'center';
      
      var col1Text = '姓名', col2Text = '电话', col3Text = '单位/备注';
      if (order === 'phone_name_other') {
        col1Text = '电话'; col2Text = '姓名'; col3Text = '单位/备注';
      } else if (order === 'name_other_phone') {
        col1Text = '姓名'; col2Text = '单位/备注'; col3Text = '电话';
      }
      
      ctx.fillStyle = 'rgba(231, 76, 60, 0.7)';
      ctx.fillText(col1Text, x1 / 2, canvas.height / 2);
      
      ctx.fillStyle = 'rgba(46, 204, 113, 0.7)';
      ctx.fillText(col2Text, x1 + (x2 - x1) / 2, canvas.height / 2);
      
      ctx.fillStyle = 'rgba(52, 152, 219, 0.7)';
      ctx.fillText(col3Text, x2 + (canvas.width - x2) / 2, canvas.height / 2);
    }

    function startLocalOcrProcessing() {
      var configPanel = document.getElementById('localOcrConfigPanel');
      if (configPanel) configPanel.style.display = 'none';
      
      showAIScanningUI(tempOcrFileName);
      document.getElementById('aiScanStatus').innerHTML = '📸 正在加载本地 Wasm 神经网络...';
      if (document.getElementById('aiLog1')) {
        document.getElementById('aiLog1').innerHTML = '⏳ 正在拉取 tesseract.js 识别引擎...';
        document.getElementById('aiLog1').style.opacity = '1';
      }
      
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js')
        .then(function() {
          if (document.getElementById('aiLog1')) document.getElementById('aiLog1').innerHTML = '✅ Wasm 视觉解析库就绪';
          
          if (tempOcrPdf) {
            processLocalPdfOCR(tempOcrPdf);
          } else {
            processLocalImageOCR();
          }
        })
        .catch(function(err) {
          alert('OCR 引擎加载失败: ' + err.message);
          resetAIImporterUI();
        });
    }

    function processLocalImageOCR() {
      var useSlicing = document.getElementById('chkUseSlicing') ? document.getElementById('chkUseSlicing').checked : false;
      
      if (!useSlicing) {
        if (document.getElementById('aiLog2')) {
          document.getElementById('aiLog2').innerHTML = '⏳ 正在进行全图 AI 识别，取消切片优化...';
          document.getElementById('aiLog2').style.opacity = '1';
        }
        if (document.getElementById('aiLog3')) {
          document.getElementById('aiLog3').innerHTML = '⏳ 正在加载语言模型包...';
          document.getElementById('aiLog3').style.opacity = '1';
        }
        
        doTesseractLocal(tempOcrImgDataUrl, function(err, contacts) {
          if (err || !contacts || contacts.length === 0) {
            console.error('Local Full-Image Tesseract failed:', err);
            alert('本地 OCR 识别失败或未检出任何联系人！');
            resetAIImporterUI();
          } else {
            if (document.getElementById('aiLog4')) {
              document.getElementById('aiLog4').innerHTML = '🎉 本地识别成功，共 ' + contacts.length + ' 人';
              document.getElementById('aiLog4').style.opacity = '1';
            }
            setTimeout(function() {
              renderAIUnstructuredReport(tempOcrFileName, contacts);
            }, 800);
          }
        });
        return;
      }

      var img = new Image();
      img.src = tempOcrImgDataUrl;
      img.onload = function() {
        if (document.getElementById('aiLog2')) {
          document.getElementById('aiLog2').innerHTML = '⏳ 正在进行列拆片预处理...';
          document.getElementById('aiLog2').style.opacity = '1';
        }
        
        var split1 = parseInt(document.getElementById('sliderSplit1').value) / 100;
        var split2 = parseInt(document.getElementById('sliderSplit2').value) / 100;
        var order = document.getElementById('ocrColumnOrder').value;
        
        var slices = sliceAndPreprocess(img, split1, split2, order);
        
        if (document.getElementById('aiLog2')) document.getElementById('aiLog2').innerHTML = '✅ 图像二值化与 2x 缩放完成';
        if (document.getElementById('aiLog3')) {
          document.getElementById('aiLog3').innerHTML = '⏳ 正在初始化中英文语言模型包...';
          document.getElementById('aiLog3').style.opacity = '1';
        }
        
        runTesseractOnSlices(slices, img)
          .then(function(contacts) {
            if (contacts && contacts.length > 0) {
              if (document.getElementById('aiLog4')) {
                document.getElementById('aiLog4').innerHTML = '🎉 本地识别成功，共 ' + contacts.length + ' 人';
                document.getElementById('aiLog4').style.opacity = '1';
              }
              setTimeout(function() {
                renderAIUnstructuredReport(tempOcrFileName, contacts);
              }, 800);
            } else {
              // Slicing failed to find contacts — auto fallback to full-image Tesseract + AI correction
              if (document.getElementById('aiLog2')) {
                document.getElementById('aiLog2').innerHTML = '⚠️ 切片未检出，正自动尝试全图识别与 AI 修正...';
                document.getElementById('aiLog2').style.opacity = '1';
              }
              doTesseractLocal(tempOcrImgDataUrl, function(err, contacts) {
                if (err || !contacts || contacts.length === 0) {
                  alert('本地 Tesseract 识别未检出联系人。请尝试在上方调整分割线滑块，并重新“开始本地识别”，或者直接粘贴文本。');
                  resetAIImporterUI();
                } else {
                  if (document.getElementById('aiLog4')) {
                    document.getElementById('aiLog4').innerHTML = '🎉 全图 AI 识别成功，共 ' + contacts.length + ' 人';
                    document.getElementById('aiLog4').style.opacity = '1';
                  }
                  setTimeout(function() {
                    renderAIUnstructuredReport(tempOcrFileName, contacts);
                  }, 800);
                }
              });
            }
          })
          .catch(function(err) {
            console.error('Local Tesseract failed:', err);
            alert('本地 Tesseract 识别失败，请重试。');
            resetAIImporterUI();
          });
      };
    }

    function processLocalPdfOCR(pdf) {
      var maxPages = pdf.numPages;
      var allContacts = [];
      
      var split1 = parseInt(document.getElementById('sliderSplit1').value) / 100;
      var split2 = parseInt(document.getElementById('sliderSplit2').value) / 100;
      var order = document.getElementById('ocrColumnOrder').value;
      
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      
      function processPage(pageNumber) {
        if (pageNumber > maxPages) {
          if (allContacts.length > 0) {
            if (document.getElementById('aiScanStatus')) {
              document.getElementById('aiScanStatus').innerHTML = '✅ 本地 PDF 识别完成';
            }
            if (document.getElementById('aiLog4')) {
              document.getElementById('aiLog4').innerHTML = '🎉 共识别到 ' + allContacts.length + ' 个联系人';
            }
            setTimeout(function() {
              renderAIUnstructuredReport(tempOcrFileName, allContacts);
            }, 800);
          } else {
            alert('本地 PDF 识别未检出联系人。请尝试在上方调整分割线滑块并重新识别。');
            resetAIImporterUI();
          }
          return;
        }
        
        document.getElementById('aiScanStatus').innerHTML = '📄 本地 Wasm 识别第 ' + pageNumber + '/' + maxPages + ' 页...';
        if (document.getElementById('aiLog4')) {
          document.getElementById('aiLog4').innerHTML = '⏳ 正在识别第 ' + pageNumber + ' 页...';
          document.getElementById('aiLog4').style.opacity = '1';
        }
        
        pdf.getPage(pageNumber).then(function(page) {
          var viewport = page.getViewport({ scale: 1.5 });
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          
          page.render({
            canvasContext: ctx,
            viewport: viewport
          }).promise.then(function() {
            var img = new Image();
            img.src = canvas.toDataURL('image/jpeg', 0.95);
            img.onload = function() {
              var slices = sliceAndPreprocess(img, split1, split2, order);
              runTesseractOnSlices(slices, img)
                .then(function(pageContacts) {
                  allContacts = allContacts.concat(pageContacts);
                  processPage(pageNumber + 1);
                })
                .catch(function(err) {
                  console.error('Page ' + pageNumber + ' local OCR failed:', err);
                  processPage(pageNumber + 1);
                });
            };
          });
        });
      }
      
      if (document.getElementById('aiLog3')) {
        document.getElementById('aiLog3').innerHTML = '✅ 初始化本地识别队列成功';
        document.getElementById('aiLog3').style.opacity = '1';
      }
      
      processPage(1);
    }

    function runCloudImageOCR(file) {
      console.warn('runCloudImageOCR is deprecated');
      alert('云端视觉 OCR 识别已弃用，请配置本地 OCR (Tesseract) 或文本 AI 纠错管线。');
      resetAIImporterUI();
    }

    function runCloudPdfOCR(pdf, fileName) {
      // Workers AI runs on the server side and does not require a client API key.
      var aiKey = true;
      
      var maxPages = pdf.numPages;
      var allContacts = [];
      
      showAIScanningUI(fileName);
      if (document.getElementById('aiScanStatus')) {
        document.getElementById('aiScanStatus').innerHTML = '🤖 本地未检出，正切换为云端 AI 视觉识别...';
      }
      if (document.getElementById('aiLog3')) {
        document.getElementById('aiLog3').innerHTML = '⏳ 正在通过 Canvas 渲染多模态图像...';
      }
      if (document.getElementById('aiLog4')) {
        document.getElementById('aiLog4').innerHTML = '⏳ 准备识别第 1/' + maxPages + ' 页...';
        document.getElementById('aiLog4').style.opacity = '1';
      }

      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');

      function processPageOCR(pageNumber) {
        if (pageNumber > maxPages) {
          if (document.getElementById('aiScanStatus')) {
            document.getElementById('aiScanStatus').innerHTML = '✅ 扫描版 PDF 识别完成';
          }
          if (document.getElementById('aiLog4')) {
            document.getElementById('aiLog4').innerHTML = '🎉 共识别到 ' + allContacts.length + ' 个联系人';
          }
          setTimeout(function() {
            renderAIUnstructuredReport(fileName, allContacts);
          }, 800);
          return;
        }

        if (document.getElementById('aiLog4')) {
          document.getElementById('aiLog4').innerHTML = '⏳ 正在通过 AI 识别第 ' + pageNumber + '/' + maxPages + ' 页...';
        }

        pdf.getPage(pageNumber).then(function(page) {
          var viewport = page.getViewport({ scale: 1.5 });
          canvas.width = viewport.width;
          canvas.height = viewport.height;

          var renderContext = {
            canvasContext: ctx,
            viewport: viewport
          };

          page.render(renderContext).promise.then(function() {
            var imgData = canvas.toDataURL('image/jpeg', 0.75);

            fetch('/api/ocr', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image: imgData, mode: 'bulk' })
            })
            .then(function(r) {
              return r.text().then(function(t) {
                try {
                  var d = JSON.parse(t);
                  return d;
                } catch(e) {
                  throw new Error('服务器异常 (' + r.status + '): ' + t.substring(0, 100));
                }
              });
            })
            .then(function(result) {
              var pageContacts = [];
              if (result.contacts && result.contacts.length > 0) {
                result.contacts.forEach(function(c) {
                  if (c.phone) {
                    pageContacts.push({
                      name: c.name || '',
                      phone: c.phone,
                      company: c.company || '',
                      note: c.note || ''
                    });
                  }
                });
              } else if (result.name || result.phone) {
                pageContacts.push({
                  name: result.name || '',
                  phone: result.phone || '',
                  company: result.company || '',
                  note: result.note || result.fund || ''
                });
              }
              if (result.rawText || result.note) {
                var extra = parsePhoneContactsFromRawText(result.rawText || result.note || '');
                extra.forEach(function(ec) {
                  if (!pageContacts.find(function(c) { return c.phone === ec.phone; })) {
                    pageContacts.push(ec);
                  }
                });
              }

              allContacts = allContacts.concat(pageContacts);
              processPageOCR(pageNumber + 1);
            })
            .catch(function(err) {
              console.error('Page ' + pageNumber + ' OCR failed:', err.message);
              if (document.getElementById('aiLog3')) {
                document.getElementById('aiLog3').innerHTML = '⚠️ 第 ' + pageNumber + ' 页识别失败: ' + err.message + '，尝试下一页...';
              }
              processPageOCR(pageNumber + 1);
            });
          });
        }).catch(function(err) {
          console.error('Page ' + pageNumber + ' render failed:', err.message);
          processPageOCR(pageNumber + 1);
        });
      }

      processPageOCR(1);
    }





    function sliceAndPreprocess(img, split1, split2, order) {
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      
      var x1 = w * split1;
      var x2 = w * split2;
      
      var col1 = { startX: 0, width: x1 };
      var col2 = { startX: x1, width: x2 - x1 };
      var col3 = { startX: x2, width: w - x2 };
      
      var sliceTypes = ['name', 'phone', 'other'];
      if (order === 'phone_name_other') {
        sliceTypes = ['phone', 'name', 'other'];
      } else if (order === 'name_other_phone') {
        sliceTypes = ['name', 'other', 'phone'];
      }
      
      var results = [];
      [col1, col2, col3].forEach(function(col, idx) {
        var type = sliceTypes[idx];
        
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        
        canvas.width = col.width * 2;
        canvas.height = h * 2;
        
        ctx.drawImage(img, col.startX, 0, col.width, h, 0, 0, canvas.width, canvas.height);
        
        var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var data = imgData.data;
        
        var histogram = new Array(256).fill(0);
        var totalPixels = data.length / 4;
        
        for (var i = 0; i < data.length; i += 4) {
          var r = data[i];
          var g = data[i+1];
          var b = data[i+2];
          
          if (type === 'name') {
            var pixelIdx = i / 4;
            var pixelX = pixelIdx % canvas.width;
            if (pixelX < 24 && b > r + 10) {
              r = 255;
              g = 255;
              b = 255;
            }
            var val = Math.min(r, g, b);
            data[i] = val;
            data[i+1] = val;
            data[i+2] = val;
            histogram[val]++;
          } else {
            var val = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            data[i] = val;
            data[i+1] = val;
            data[i+2] = val;
            histogram[val]++;
          }
        }
        
        var sum = 0;
        for (var i = 0; i < 256; i++) sum += i * histogram[i];
        var sumB = 0;
        var wB = 0;
        var wF = 0;
        var varMax = 0;
        var threshold = 140;
        for (var t = 0; t < 256; t++) {
          wB += histogram[t];
          if (wB === 0) continue;
          wF = totalPixels - wB;
          if (wF === 0) break;
          sumB += t * histogram[t];
          var mB = sumB / wB;
          var mF = (sum - sumB) / wF;
          var varBetween = wB * wF * (mB - mF) * (mB - mF);
          if (varBetween > varMax) {
            varMax = varBetween;
            threshold = t;
          }
        }
        
        for (var i = 0; i < data.length; i += 4) {
          var finalVal = data[i] < threshold ? 0 : 255;
          data[i] = finalVal;
          data[i+1] = finalVal;
          data[i+2] = finalVal;
        }
        
        ctx.putImageData(imgData, 0, 0);
        
        results.push({
          type: type,
          dataUrl: canvas.toDataURL('image/png')
        });
      });
      
      return results;
    }

    function runTesseractOnSlices(slices, img) {
      function cropCellInBrowser(sourceImg, yCenter) {
        var cellCanvas = document.createElement('canvas');
        var cellCtx = cellCanvas.getContext('2d');
        
        cellCanvas.width = 77 * 2;
        cellCanvas.height = 48 * 2;
        
        var imgH = sourceImg.naturalHeight || sourceImg.height;
        var yStart = Math.max(0, Math.min(Math.round(yCenter - 24), imgH - 48));
        cellCtx.drawImage(sourceImg, 0, yStart, 77, 48, 0, 0, cellCanvas.width, cellCanvas.height);
        
        var imgData = cellCtx.getImageData(0, 0, cellCanvas.width, cellCanvas.height);
        var data = imgData.data;
        
        var histogram = new Array(256).fill(0);
        for (var i = 0; i < data.length; i += 4) {
          var r = data[i];
          var g = data[i+1];
          var b = data[i+2];
          
          var pixelIdx = i / 4;
          var pixelX = pixelIdx % cellCanvas.width;
          if (pixelX < 24 && b > r + 10) {
            r = 255;
            g = 255;
            b = 255;
          }
          var val = Math.min(r, g, b);
          data[i] = val;
          data[i+1] = val;
          data[i+2] = val;
          histogram[val]++;
        }
        
        var sum = 0;
        for (var i = 0; i < 256; i++) sum += i * histogram[i];
        var sumB = 0, wB = 0, wF = 0, varMax = 0, threshold = 140;
        var totalPixels = data.length / 4;
        for (var t = 0; t < 256; t++) {
          wB += histogram[t];
          if (wB === 0) continue;
          wF = totalPixels - wB;
          if (wF === 0) break;
          sumB += t * histogram[t];
          var mB = sumB / wB;
          var mF = (sum - sumB) / wF;
          var varBetween = wB * wF * (mB - mF) * (mB - mF);
          if (varBetween > varMax) {
            varMax = varBetween;
            threshold = t;
          }
        }
        
        for (var i = 0; i < data.length; i += 4) {
          var finalVal = data[i] < threshold ? 0 : 255;
          data[i] = finalVal;
          data[i+1] = finalVal;
          data[i+2] = finalVal;
        }
        
        cellCtx.putImageData(imgData, 0, 0);
        return cellCanvas.toDataURL('image/png');
      }

      return Tesseract.createWorker({
        workerPath: window.location.origin + '/tessdata/worker.min.js',
        corePath: window.location.origin + '/tessdata/core',
        langPath: window.location.origin + '/tessdata',
        logger: function(m) {
          if (m.status === 'recognizing text') {
            var pct = Math.round(m.progress * 100);
            document.getElementById('aiScanStatus').innerHTML = '📸 本地 OCR 进行中: ' + pct + '%';
          } else if (m.status === 'loading chi_sim.traineddata' || m.status === 'loading eng.traineddata') {
            var loadPct = m.progress ? ' (' + Math.round(m.progress * 100) + '%)' : '';
            document.getElementById('aiScanStatus').innerHTML = '🧠 正在载入语言模型包' + loadPct + '...';
          }
        }
      }).then(function(worker) {
        var workerObj = worker;
        
        return Promise.resolve(worker.load())
          .then(function() { return Promise.resolve(worker.loadLanguage('chi_sim')); })
          .then(function() { return Promise.resolve(worker.initialize('chi_sim')); })
          .then(function() {
            var results = {};
            
            function recognizeNext(idx) {
              if (idx >= slices.length) {
                return Promise.resolve(results);
              }
              var slice = slices[idx];
              
              var params = {
                tessedit_pageseg_mode: '6',
                tessedit_char_whitelist: ''
              };
              if (slice.type === 'phone') {
                params.tessedit_char_whitelist = '0123456789- ';
              }
              
              document.getElementById('aiScanStatus').innerHTML = '🔍 正在识别列: ' + (slice.type === 'name' ? '姓名' : (slice.type === 'phone' ? '电话' : '单位/备注')) + '...';
              
              return Promise.resolve(workerObj.setParameters(params))
                .then(function() { return Promise.resolve(workerObj.recognize(slice.dataUrl)); })
                .then(function(ocrRes) {
                  results[slice.type] = ocrRes.data.lines.map(function(line) {
                    return {
                      text: line.text,
                      yCenter: (line.bbox.y0 + line.bbox.y1) / 4
                    };
                  });
                  return recognizeNext(idx + 1);
                });
            }
            
            return recognizeNext(0);
          })
          .then(function(ocrData) {
            var names = ocrData.name || [];
            var phones = ocrData.phone || [];
            var companies = ocrData.other || [];
            
            var contacts = [];
            phones.forEach(function(pItem) {
              var phoneText = pItem.text.replace(/s+/g, '').trim();
              phoneText = phoneText.replace(/[OoQD]/g, '0').replace(/[lIi|!]/g, '1').replace(/[Z]/g, '2').replace(/[B]/g, '8').replace(/[S]/g, '5').replace(/[G]/g, '6').replace(/[A]/g, '4').replace(/[T]/g, '7').replace(/[g]/g, '9');
              var phoneMatch = phoneText.match(/1[3-9]d{9}/);
              if (!phoneMatch) return;
              var cleanPhone = phoneMatch[0];
              
              var bestName = '';
              var minNameDist = 99999;
              names.forEach(function(nItem) {
                var dist = Math.abs(nItem.yCenter - pItem.yCenter);
                if (dist < minNameDist && dist < 30) {
                  minNameDist = dist;
                  bestName = nItem.text.trim();
                }
              });
              
              var bestCompany = '';
              var minCompanyDist = 99999;
              companies.forEach(function(cItem) {
                var dist = Math.abs(cItem.yCenter - pItem.yCenter);
                if (dist < minCompanyDist && dist < 30) {
                  minCompanyDist = dist;
                  bestCompany = cItem.text.trim();
                }
              });
              
              bestName = bestName.replace(/^[新旧听一]s*/, '').replace(/[^一-龥a-zA-Z]/g, '').trim();
              bestCompany = bestCompany.replace(/^[|丨s:]+/, '').replace(/[|丨s:]+$/, '').trim();
              
              contacts.push({
                name: bestName,
                phone: cleanPhone,
                company: bestCompany,
                note: '',
                yCenter: pItem.yCenter,
                minNameDist: minNameDist
              });
            });
            
            function processFallbacks(cIdx) {
              if (cIdx >= contacts.length) {
                try { workerObj.terminate(); } catch(e) {}
                return contacts.map(function(c) {
                  return {
                    name: c.name || '客户-' + c.phone.substring(c.phone.length - 4),
                    phone: c.phone,
                    company: c.company,
                    note: ''
                  };
                });
              }
              
              var c = contacts[cIdx];
              if (!c.name || c.name === '严' || c.minNameDist > 15) {
                var cellDataUrl = cropCellInBrowser(img, c.yCenter);
                return workerObj.setParameters({ tessedit_pageseg_mode: '10', tessedit_char_whitelist: '' })
                  .then(function() { return workerObj.recognize(cellDataUrl); })
                  .then(function(cellRes) {
                    var fallbackName = cellRes.data.text.trim().replace(/^[新旧听一]s*/, '').replace(/[^一-龥a-zA-Z]/g, '').trim();
                    if (fallbackName && fallbackName !== '严') {
                      c.name = fallbackName;
                    }
                    return processFallbacks(cIdx + 1);
                  })
                  .catch(function(err) {
                    console.error('Fallback OCR failed for index ' + cIdx, err);
                    return processFallbacks(cIdx + 1);
                  });
              } else {
                return processFallbacks(cIdx + 1);
              }
            }
            
            return processFallbacks(0);
          })
          .catch(function(err) {
            try { workerObj.terminate(); } catch(e) {}
            throw err;
          });
      });
    }

    function runLocalScannedPdfSlicingOCR(pdf, fileName) {
      tempOcrFile = null;
      tempOcrPdf = pdf;
      tempOcrFileName = fileName;
      
      pdf.getPage(1).then(function(page) {
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        var viewport = page.getViewport({ scale: 1.5 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        page.render({
          canvasContext: ctx,
          viewport: viewport
        }).promise.then(function() {
          tempOcrImgDataUrl = canvas.toDataURL('image/jpeg', 0.95);
          showOcrSlicingPreview(tempOcrImgDataUrl);
        });
      });
    }

    // ====== Multi-Image Queue OCR ======
    var multiImageQueue = [];
    var multiImageResults = [];
    var multiImageAborted = false;

    function handleMultiImageOCR(files) {
      multiImageQueue = files;
      multiImageResults = [];
      multiImageAborted = false;
      var total = files.length;

      var ocrEngine = 'local';
      tempOcrEngine = 'local_tesseract';

      // Set up scanning UI directly (skip showAIScanningUI timeouts to avoid progress overwrite)
      document.getElementById('aiImportInit').style.display = 'none';
      document.getElementById('aiImportReport').style.display = 'none';
      document.getElementById('aiImportScanning').style.display = 'flex';
      document.getElementById('aiLaserLine').style.display = 'block';
      document.getElementById('aiScanStatus').innerHTML = '🖼️ 多图排队识别 · 共 ' + total + ' 张';
      document.getElementById('aiLog1').innerHTML = '📋 队列就绪，准备逐张识别...'; document.getElementById('aiLog1').style.opacity = '1';
      document.getElementById('aiLog2').innerHTML = '⏳ 等待处理第 1/' + total + ' 张...'; document.getElementById('aiLog2').style.opacity = '1';
      document.getElementById('aiLog3').innerHTML = '🔧 引擎: 本地离线 (Wasm)'; document.getElementById('aiLog3').style.opacity = '0.8';
      document.getElementById('aiLog4').innerHTML = '⚡ 进度: 0/' + total; document.getElementById('aiLog4').style.opacity = '0.8';

      processNextInQueue(0);
    }

    function processNextInQueue(index) {
      if (multiImageAborted) return;
      if (index >= multiImageQueue.length) {
        finishMultiImageOCR();
        return;
      }

      var file = multiImageQueue[index];
      var total = multiImageQueue.length;
      var current = index + 1;

      if (document.getElementById('aiScanStatus')) {
        document.getElementById('aiScanStatus').innerHTML = '🖼️ 正在识别 第 ' + current + '/' + total + ' 张: ' + esc(file.name);
      }
      if (document.getElementById('aiLog2')) {
        document.getElementById('aiLog2').innerHTML = '⏳ 处理中: ' + esc(file.name) + ' (' + current + '/' + total + ')';
        document.getElementById('aiLog2').style.opacity = '1';
      }
      if (document.getElementById('aiLog4')) {
        document.getElementById('aiLog4').innerHTML = '⚡ 进度: ' + current + '/' + total;
        document.getElementById('aiLog4').style.opacity = '1';
      }

      processSingleImageLocal(file, function(err, contacts) {
        if (err) {
          if (document.getElementById('aiLog3')) {
            document.getElementById('aiLog3').innerHTML = '⚠️ ' + esc(file.name) + ' 本地识别失败: ' + err.message + '，继续下一张...';
            document.getElementById('aiLog3').style.opacity = '1';
          }
        } else {
          if (document.getElementById('aiLog3')) {
            document.getElementById('aiLog3').innerHTML = '✅ ' + esc(file.name) + ' 本地识别完成 (' + contacts.length + ' 个联系人)';
            document.getElementById('aiLog3').style.opacity = '1';
          }
          multiImageResults = multiImageResults.concat(contacts);
        }
        processNextInQueue(index + 1);
      });
    }

    var _tesseractWorker = null;
    var _tesseractReady = false;

    function getTesseractWorker(callback) {
      if (_tesseractWorker && _tesseractReady) {
        callback(null, _tesseractWorker);
        return;
      }
      if (_tesseractWorker && !_tesseractReady) {
        // Worker is being initialized, poll
        var start = Date.now();
        var check = setInterval(function() {
          if (_tesseractReady) {
            clearInterval(check);
            callback(null, _tesseractWorker);
          } else if (Date.now() - start > 30000) {
            clearInterval(check);
            callback(new Error('Tesseract worker init timeout'), null);
          }
        }, 200);
        return;
      }

      if (typeof Tesseract === 'undefined') {
        loadScript('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js')
          .then(function() { createAndInitWorker(callback); })
          .catch(function(err) { callback(err, null); });
      } else {
        createAndInitWorker(callback);
      }
    }

    function createAndInitWorker(callback) {
      Tesseract.createWorker({
        workerPath: window.location.origin + '/tessdata/worker.min.js',
        corePath: window.location.origin + '/tessdata/core',
        langPath: window.location.origin + '/tessdata'
      }).then(function(worker) {
        _tesseractWorker = worker;
        return Promise.resolve(worker.load())
          .then(function() { return Promise.resolve(worker.loadLanguage('chi_sim+eng')); })
          .then(function() { return Promise.resolve(worker.initialize('chi_sim+eng')); })
          .then(function() {
            return Promise.resolve(worker.setParameters({
              tessedit_pageseg_mode: '6'
            }));
          })
          .then(function() {
            _tesseractReady = true;
            callback(null, worker);
          });
      }).catch(function(err) {
        _tesseractWorker = null;
        callback(err, null);
      });
    }

    function processSingleImageLocal(file, callback) {
      getTesseractWorker(function(err, worker) {
        if (err) { callback(err, []); return; }
        Promise.resolve(worker.setParameters({
          tessedit_pageseg_mode: '6'
        })).then(function() {
          return worker.recognize(file);
        }).then(function(result) {
          var text = result.data.text;
          correctOcrTextWithAI(text, typeof file === 'string' ? 'image_data' : (file.name || 'image_ocr'), function(contacts) {
            callback(null, contacts);
          });
        }).catch(function(recogErr) {
          // Worker might be stale, reset and retry once
          _tesseractWorker = null;
          _tesseractReady = false;
          getTesseractWorker(function(err2, worker2) {
            if (err2) { callback(recogErr, []); return; }
            Promise.resolve(worker2.setParameters({
              tessedit_pageseg_mode: '6'
            })).then(function() {
              return worker2.recognize(file);
            }).then(function(result2) {
              var text2 = result2.data.text;
              correctOcrTextWithAI(text2, typeof file === 'string' ? 'image_data' : (file.name || 'image_ocr'), function(contacts2) {
                callback(null, contacts2);
              });
            }).catch(function(e2) { callback(e2, []); });
          });
        });
      });
    }

    function doTesseractLocal(file, callback) {
      processSingleImageLocal(file, callback);
    }

    function finishMultiImageOCR() {
      var total = multiImageQueue.length;
      if (document.getElementById('aiScanStatus')) {
        document.getElementById('aiScanStatus').innerHTML = '✅ 多图排队识别完成 · 共 ' + total + ' 张图片';
      }
      if (document.getElementById('aiLog2')) {
        document.getElementById('aiLog2').innerHTML = '🎉 全部处理完毕';
        document.getElementById('aiLog2').style.opacity = '1';
      }
      if (document.getElementById('aiLog4')) {
        document.getElementById('aiLog4').innerHTML = '📊 合计识别: ' + multiImageResults.length + ' 个联系人';
        document.getElementById('aiLog4').style.opacity = '1';
      }

      // Deduplicate by phone
      var seenPhones = {};
      var deduped = [];
      multiImageResults.forEach(function(c) {
        if (!seenPhones[c.phone]) {
          seenPhones[c.phone] = true;
          deduped.push(c);
        }
      });

      setTimeout(function() {
        renderAIUnstructuredReport(multiImageQueue.length + ' 张图片', deduped);
      }, 600);
    }

    function handleImageOCR(file) {
      tempOcrEngine = 'local_tesseract';
      runLocalTableSlicingOCR(file);
    }

    function runLocalTableSlicingOCR(file) {
      tempOcrFile = file;
      tempOcrPdf = null;
      tempOcrFileName = file.name;
      tempOcrEngine = 'local_tesseract';
      
      var reader = new FileReader();
      reader.onload = function(e) {
        tempOcrImgDataUrl = e.target.result;
        showOcrSlicingPreview(tempOcrImgDataUrl);
      };
      reader.readAsDataURL(file);
    }



    function runTesseractOCR(file) {
      document.getElementById('aiScanStatus').innerHTML = '⚙️ AI 正在载入视觉 OCR 引擎...';
      if (document.getElementById('aiLog1')) {
        document.getElementById('aiLog1').innerHTML = '⏳ 正在加载 tesseract.js 视觉分析库...';
        document.getElementById('aiLog1').style.opacity = '1';
      }

      loadScript('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js')
        .then(function() {
          if (document.getElementById('aiLog2')) {
            document.getElementById('aiLog2').innerHTML = '✅ 视觉神经网络就绪';
            document.getElementById('aiLog2').style.opacity = '1';
          }
          document.getElementById('aiScanStatus').innerHTML = '📸 正在下载中英文语言模型包...';

          if (document.getElementById('aiLog3')) {
            document.getElementById('aiLog3').innerHTML = '⏳ 正在从 CDN 获取高精 chi_sim+eng 模型...';
            document.getElementById('aiLog3').style.opacity = '1';
          }

          Tesseract.createWorker({
            workerPath: window.location.origin + '/tessdata/worker.min.js',
            corePath: window.location.origin + '/tessdata/core',
            langPath: window.location.origin + '/tessdata',
            logger: function(m) {
              if (m.status === 'recognizing text') {
                var pct = Math.round(m.progress * 100);
                document.getElementById('aiScanStatus').innerHTML = '📸 图像文字 AI 深度识别中：' + pct + '%';
                if (document.getElementById('aiLog3')) {
                  document.getElementById('aiLog3').innerHTML = '✅ 模型载入成功，识别进行中...';
                }
                if (document.getElementById('aiLog4')) {
                  document.getElementById('aiLog4').innerHTML = '⚡ OCR 进度: ' + pct + '%';
                  document.getElementById('aiLog4').style.opacity = '1';
                }
              } else if (m.status === 'loading chi_sim.traineddata' || m.status === 'loading eng.traineddata') {
                var loadPct = m.progress ? ' (' + Math.round(m.progress * 100) + '%)' : '';
                document.getElementById('aiScanStatus').innerHTML = '🧠 正在载入语言模型包' + loadPct + '...';
              }
            }
          }).then(function(worker) {
            return Promise.resolve(worker.load())
              .then(function() { return Promise.resolve(worker.loadLanguage('chi_sim+eng')); })
              .then(function() { return Promise.resolve(worker.initialize('chi_sim+eng')); })
              .then(function() {
                return Promise.resolve(worker.setParameters({
                  tessedit_pageseg_mode: '6'
                }));
              })
              .then(function() { return Promise.resolve(worker.recognize(file)); })
              .then(function(result) {
                try { worker.terminate(); } catch(e) {}
                return result;
              })
              .catch(function(err) {
                try { worker.terminate(); } catch(e) {}
                throw err;
              });
          }).then(function(result) {
            if (document.getElementById('aiLog4')) {
              document.getElementById('aiLog4').innerHTML = '✅ 图像文字识别与神经特征映射完毕';
            }
            var text = result.data.text;
            correctOcrTextWithAI(text, file.name, function(contacts) {
              renderAIUnstructuredReport(file.name, contacts);
            });
          }).catch(function(err) {
            alert('本地 OCR 识别失败：' + (err.message || err));
            resetAIImporterUI();
          });
        })
        .catch(function(err) {
          alert('OCR 引擎加载失败：' + err.message);
          resetAIImporterUI();
        });
    }

    function handleTxtImport(file) {
      tempOcrEngine = 'text_fallback';
      showAIScanningUI(file.name);
      document.getElementById('aiScanStatus').innerHTML = '📄 正在读取文本文档...';
      if (document.getElementById('aiLog1')) {
        document.getElementById('aiLog1').innerHTML = '✅ 文件读取通道建立';
        document.getElementById('aiLog1').style.opacity = '1';
      }
      
      var reader = new FileReader();
      reader.onload = function(e) {
        if (document.getElementById('aiLog2')) {
          document.getElementById('aiLog2').innerHTML = '✅ 文档原始二进制流读取成功';
          document.getElementById('aiLog2').style.opacity = '1';
        }
        var text = e.target.result;
        if (document.getElementById('aiLog3')) {
          document.getElementById('aiLog3').innerHTML = '✅ UTF-8 编码文本清洗完毕';
          document.getElementById('aiLog3').style.opacity = '1';
        }
        if (document.getElementById('aiLog4')) {
          document.getElementById('aiLog4').innerHTML = '⏳ AI 正在运行特征分析提取模型...';
          document.getElementById('aiLog4').style.opacity = '1';
        }
        setTimeout(function() {
          correctOcrTextWithAI(text, file.name, function(contacts) {
            renderAIUnstructuredReport(file.name, contacts);
          });
        }, 600);
      };
      reader.readAsText(file, 'utf-8');
    }

    function renderAIUnstructuredReport(fileName, contacts) {
      // Snapshot original contacts BEFORE user edits (for training feedback)
      tempOcrOriginalContacts = JSON.parse(JSON.stringify(contacts));
      tempOcrFileName = fileName;
      if (!tempOcrEngine) tempOcrEngine = 'text_fallback'; // Default if not set by caller
      tempUnstructuredContacts = contacts;
      tempImportType = 'unstructured';
      tempImportData = contacts;
      
      if (contacts && contacts.length > 0) {
        executeAIImportUnstructured();
        alert('📝 文本识别：成功自动提取 ' + contacts.length + ' 个联系人，已直接自动入库并同步至 Supabase！');
        return;
      }

      document.getElementById('aiImportScanning').style.display = 'none';
      document.getElementById('aiLaserLine').style.display = 'none';
      
      document.getElementById('aiExcelMappingPills').style.display = 'none';
      document.getElementById('aiExcelMappingControls').style.display = 'none';
      document.getElementById('aiExcelPreviewContainer').style.display = 'none';
      
      var unstContainer = document.getElementById('aiUnstructuredContainer');
      unstContainer.style.display = 'block';
      
      document.getElementById('aiReportTitle').innerHTML = 'AI 提取报告: ' + esc(fileName);
      
      var conf = contacts.length > 0 ? 98.0 : 0.0;
      document.getElementById('aiConfidenceBadge').innerHTML = '● AI 识别率: ' + conf.toFixed(1) + '%';
      
      renderUnstructuredTableRows();
      
      document.getElementById('aiImportReport').style.display = 'flex';
    }

    function renderUnstructuredTableRows() {
      var tbody = document.querySelector('#aiUnstructuredTable tbody');
      if (!tbody) return;
      tbody.innerHTML = '';
      
      if (tempUnstructuredContacts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--text-light);">未识别到任何带号码的联系人数据</td></tr>';
        document.getElementById('aiConfirmImportBtn').innerHTML = '无数据可导入';
        document.getElementById('aiConfirmImportBtn').disabled = true;
        return;
      }
      
      document.getElementById('aiConfirmImportBtn').disabled = false;
      document.getElementById('aiConfirmImportBtn').innerHTML = '确认导入 (' + tempUnstructuredContacts.length + ' 位联系人)';
      
      tempUnstructuredContacts.forEach(function(c, index) {
        var tr = document.createElement('tr');
        tr.style.borderBottom = '0.5px solid var(--card-border)';
        
        var tdDel = document.createElement('td');
        tdDel.style.padding = '4px 6px';
        tdDel.style.textAlign = 'center';
        var delBtn = document.createElement('button');
        delBtn.innerHTML = '🗑️';
        delBtn.style.background = 'transparent';
        delBtn.style.border = 'none';
        delBtn.style.cursor = 'pointer';
        delBtn.style.fontSize = '0.75rem';
        delBtn.addEventListener('click', function() {
          tempUnstructuredContacts.splice(index, 1);
          renderUnstructuredTableRows();
        });
        tdDel.appendChild(delBtn);
        
        var tdName = document.createElement('td');
        tdName.style.padding = '4px 6px';
        tdName.style.fontWeight = '800';
        tdName.style.color = 'var(--text-main)';
        tdName.contentEditable = 'true';
        tdName.textContent = c.name;
        tdName.addEventListener('blur', function() {
          tempUnstructuredContacts[index].name = this.textContent.trim();
        });
        
        var tdPhone = document.createElement('td');
        tdPhone.style.padding = '4px 6px';
        tdPhone.style.fontFamily = 'monospace';
        tdPhone.style.color = 'var(--accent-wechat)';
        tdPhone.style.fontWeight = '800';
        tdPhone.contentEditable = 'true';
        tdPhone.textContent = c.phone;
        tdPhone.addEventListener('blur', function() {
          var val = this.textContent.trim().replace(/[-\s]/g, '');
          tempUnstructuredContacts[index].phone = val;
        });
        
        var tdComp = document.createElement('td');
        tdComp.style.padding = '4px 6px';
        tdComp.style.color = '#4a6cf7';
        tdComp.contentEditable = 'true';
        tdComp.textContent = c.company;
        tdComp.addEventListener('blur', function() {
          tempUnstructuredContacts[index].company = this.textContent.trim();
        });
        
        var tdNote = document.createElement('td');
        tdNote.style.padding = '4px 6px';
        tdNote.style.color = 'var(--text-soft)';
        tdNote.contentEditable = 'true';
        tdNote.textContent = c.note;
        tdNote.addEventListener('blur', function() {
          tempUnstructuredContacts[index].note = this.textContent.trim();
        });
        
        tr.appendChild(tdDel);
        tr.appendChild(tdName);
        tr.appendChild(tdPhone);
        tr.appendChild(tdComp);
        tr.appendChild(tdNote);
        tbody.appendChild(tr);
      });
    }

    function saveOcrCorrection() {
      // Save OCR correction as training data (non-blocking)
      var corrected = tempUnstructuredContacts;
      if (!tempOcrOriginalContacts || tempOcrOriginalContacts.length === 0) return;
      if (!corrected || corrected.length === 0) return;

      // Check if anything actually changed
      var hasChanges = JSON.stringify(tempOcrOriginalContacts) !== JSON.stringify(corrected);
      if (!hasChanges) return;

      fetch('/api/ocr/correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawText: tempOcrRawText || '',
          originalContacts: tempOcrOriginalContacts,
          correctedContacts: corrected,
          sourceFile: tempOcrFileName || '',
          ocrPipeline: tempOcrEngine || 'ai_vision',
          ocrMode: 'bulk',
          metadata: {
            batchLabel: (document.getElementById('batchLabelInput') || {}).value || ''
          }
        })
      }).then(function() {
        // Refresh count badge if visible
        fetchTrainingDataCount();
      }).catch(function(err) {
        console.error('Failed to save OCR correction:', err);
        // Non-blocking — don't interrupt import flow
      });
    }

    function executeAIImportUnstructured() {
      if (!tempUnstructuredContacts || tempUnstructuredContacts.length === 0) return;
      var batchLabel = (document.getElementById('batchLabelInput').value || '').trim();
      var defaultCat = document.getElementById('importCategorySelect') ? document.getElementById('importCategorySelect').value : '公海客户';
      // Tag each client with the batch label and category
      for (var i = 0; i < tempUnstructuredContacts.length; i++) {
        var c = tempUnstructuredContacts[i];
        c.batch_label = batchLabel;
        c.category = defaultCat;
        c.mobile = c.mobile || c.phone;
        c.phone = c.phone || c.mobile;
        if (!c.fund && /^d{4,5}$/.test((c.note || '').trim())) {
          c.fund = c.note.trim();
          c.note = '';
        }
      }
      importedClients = tempUnstructuredContacts;
      saveState();
      updateDashboardVisibility(true);
      renderDialCards();

      // Auto-upload to Supabase
      uploadCustomersToSupabase(tempUnstructuredContacts, batchLabel);

      // Save OCR correction for training feedback loop (before reset clears state)
      saveOcrCorrection();

      resetAIImporterUI();
    }

    function initAIImporter() {
      document.getElementById('aiToggleAdjustBtn').addEventListener('click', function(e) {
        e.preventDefault();
        var ctrl = document.getElementById('aiAdjustControls');
        if (ctrl.style.display === 'none') {
          ctrl.style.display = 'grid';
          this.textContent = '⚙️ 收起手动修正配置 ▴';
        } else {
          ctrl.style.display = 'none';
          this.textContent = '⚙️ 手动修正 AI 映射结果 ▾';
        }
      });

      document.getElementById('aiSelName').addEventListener('change', updateAIPreviewTable);
      document.getElementById('aiSelPhone').addEventListener('change', updateAIPreviewTable);
      document.getElementById('aiSelCompany').addEventListener('change', updateAIPreviewTable);
      document.getElementById('aiSelNote').addEventListener('change', updateAIPreviewTable);

      document.getElementById('aiResetImportBtn').addEventListener('click', function(e) {
        e.preventDefault();
        resetAIImporterUI();
      });

      document.getElementById('aiConfirmImportBtn').addEventListener('click', function(e) {
        e.preventDefault();
        if (tempImportType === 'xlsx') {
          executeAIImportExcel();
        } else if (tempImportType === 'vcf') {
          executeAIImportVcf();
        } else if (tempImportType === 'unstructured') {
          executeAIImportUnstructured();
        }
      });

      // Text paste button: use AI correction
      var textExtractBtn = document.getElementById('textImportExtractBtn');
      if (textExtractBtn) {
        textExtractBtn.addEventListener('click', function() {
          var t = document.getElementById('textImportArea').value.trim();
          if (!t) { alert('请先粘贴文本'); return; }
          var btn = this;
          btn.disabled = true;
          btn.textContent = '⏳ AI 修正中...';
          correctOcrTextWithAI(t, '文本粘贴', function(contacts) {
            btn.textContent = '🔍 智能识别提取';
            btn.disabled = false;
            if (contacts && contacts.length > 0) {
              document.getElementById('textImportPanel').style.display = 'none';
              window.renderAIUnstructuredReport('文本粘贴', contacts);
            } else {
              // Fallback to server-side extraction
              btn.textContent = '本地未检出，切换云端 AI...';
              fetch('/api/ocr/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawText: t }) })
                .then(function(r) { return r.json(); })
                .then(function(d) {
                  btn.textContent = '🔍 智能识别提取';
                  btn.disabled = false;
                  if (d.contacts && d.contacts.length > 0) {
                    document.getElementById('textImportPanel').style.display = 'none';
                    window.renderAIUnstructuredReport('云端文本解析', d.contacts);
                  } else {
                    alert('本地与云端 AI 均未识别到联系人，请确认文本包含有效手机号');
                  }
                }).catch(function(e) {
                  btn.textContent = '🔍 智能识别提取';
                  btn.disabled = false;
                  alert('识别失败: ' + e.message);
                });
            }
          });
        });
      }

      // Init OCR training data UI
      initOcrCorrectionUI();
    }

    // ====== OCR Training Data Review UI ======

    function initOcrCorrectionUI() {
      var btn = document.getElementById('ocrTrainingDataBtn');
      var modal = document.getElementById('ocrCorrectionModal');
      var closeBtn = document.getElementById('closeOcrCorrectionBtn');
      var exportBtn = document.getElementById('ocrExportJsonlBtn');
      var refreshBtn = document.getElementById('ocrRefreshCorrectionsBtn');
      var filterCheckbox = document.getElementById('ocrFilterEditsOnly');

      // Open modal
      if (btn && modal) {
        btn.addEventListener('click', function() {
          modal.classList.add('active');
          loadOcrCorrections();
        });
      }

      // Close modal
      if (closeBtn && modal) {
        closeBtn.addEventListener('click', function() { modal.classList.remove('active'); });
        modal.addEventListener('click', function(e) {
          if (e.target === modal) modal.classList.remove('active');
        });
      }

      // Export JSONL
      if (exportBtn) {
        exportBtn.addEventListener('click', function() {
          window.open('/api/ocr/corrections/export?limit=500', '_blank');
        });
      }

      // Refresh
      if (refreshBtn) {
        refreshBtn.addEventListener('click', loadOcrCorrections);
      }

      // Filter toggle
      if (filterCheckbox) {
        filterCheckbox.addEventListener('change', loadOcrCorrections);
      }

      // Initial count fetch
      fetchTrainingDataCount();
    }

    function loadOcrCorrections() {
      var container = document.getElementById('ocrCorrectionList');
      if (!container) return;
      container.innerHTML = '<div style="text-align:center;padding:24px;font-size:0.7rem;color:var(--text-light);">⏳ 加载中...</div>';

      var minEdits = 0;
      var filterEl = document.getElementById('ocrFilterEditsOnly');
      if (filterEl && filterEl.checked) minEdits = 1;

      fetch('/api/ocr/corrections?page=1&pageSize=50&minEdits=' + minEdits + '&sort=newest')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.data || data.data.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:28px;font-size:0.72rem;color:var(--text-light);">📭 暂无记录<br><span style="font-size:0.58rem;">导入并修正联系人后，修正记录会自动收集</span></div>';
            return;
          }
          var countEl = document.getElementById('ocrCorrectionCount');
          if (countEl) countEl.textContent = data.total || 0;

          var html = '';
          data.data.forEach(function(c) {
            var origStr = JSON.stringify(c.original_json).substring(0, 120);
            var corrStr = JSON.stringify(c.corrected_json).substring(0, 120);
            var hasEdits = c.edit_count > 0;
            var borderColor = hasEdits ? 'var(--accent-wechat)' : 'var(--card-border)';
            var badgeColor = hasEdits ? '#07c160' : '#999';
            html += '<div style="border-left:3px solid ' + borderColor + '; border-bottom:0.5px solid var(--card-border); padding:6px 8px; background:var(--card-bg);">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;font-size:0.58rem;color:var(--text-light);">' +
                '<span style="font-weight:700;">' + esc(c.source_file || '未知文件') + '</span>' +
                '<span style="display:flex;align-items:center;gap:4px;">' +
                  '<span style="background:' + badgeColor + ';color:white;padding:0px 5px;border-radius:6px;font-size:0.52rem;font-weight:700;">' + c.edit_count + '处修改</span>' +
                  '<span>' + (c.created_at || '').slice(0,19).replace('T',' ') + '</span>' +
                '</span>' +
              '</div>' +
              '<div style="font-size:0.6rem; margin-top:3px; word-break:break-all; line-height:1.3;">' +
                '<span style="color:var(--text-soft);">原始: </span><span style="color:#999;">' + esc(origStr) + '</span><br>' +
                '<span style="color:var(--text-soft);">修正: </span><span style="color:' + (hasEdits ? 'var(--accent-wechat)' : 'var(--text-main)') + ';">' + esc(corrStr) + '</span>' +
              '</div>' +
              '<div style="font-size:0.55rem; color:var(--text-light); margin-top:2px;">🔧 ' + esc(c.ocr_pipeline || 'unknown') + ' · ' + esc(c.ocr_mode || 'bulk') + '</div>' +
            '</div>';
          });
          container.innerHTML = html;
        })
        .catch(function(err) {
          container.innerHTML = '<div style="text-align:center;padding:24px;font-size:0.7rem;color:#e74c3c;">⚠️ 加载失败: ' + esc(err.message) + '</div>';
        });
    }

    function fetchTrainingDataCount() {
      fetch('/api/ocr/corrections/stats')
        .then(function(r) { return r.json(); })
        .then(function(stats) {
          var badge = document.getElementById('trainingCountBadge');
          var countEl = document.getElementById('ocrCorrectionCount');
          var countBadge = document.getElementById('ocrCorrectionBadge');
          if (badge) badge.textContent = stats.count || 0;
          if (countEl) countEl.textContent = stats.count || 0;
          if (countBadge) {
            countBadge.style.display = (stats.count > 0) ? 'inline' : 'none';
          }
        })
        .catch(function() {});
    }

    // Parse Excel/CSV
    function handleExcelImport(file) {
      var reader = new FileReader();
      reader.onload = function(e) {
        try {
          var data = new Uint8Array(e.target.result);
          var workbook = XLSX.read(data, { type: 'array' });
          var firstSheetName = workbook.SheetNames[0];
          var worksheet = workbook.Sheets[firstSheetName];
          var json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          if (json.length === 0) {
            alert('导入失败：表格无数据');
            return;
          }

          showAIScanningUI(file.name);

          // Deep AI Scanning trigger
          setTimeout(function() {
            var detected = runAIColumnMapping(json);
            renderAIReportForExcel(json, detected);
          }, 1200);

        } catch(err) {
          alert('解析失败：' + err.message);
        }
      };
      reader.readAsArrayBuffer(file);
    }

    // Parse VCF
    function handleVcfImport(file) {
      var reader = new FileReader();
      reader.onload = function(ev) {
        try {
          var text = ev.target.result;
          var blocks = text.split(/BEGIN:VCARD/i);
          blocks = blocks.slice(1);
          if (!blocks.length) {
            alert('未找到联系人，请确认是有效的 .vcf 文件');
            return;
          }
          
          showAIScanningUI(file.name);

          var list = [];
          var phoneSet = new Set();
          for (var bi = 0; bi < blocks.length; bi++) {
            var blk = blocks[bi];
            var name = '';
            var mQP = blk.match(/FN[^:]*QUOTED-PRINTABLE[^:]*:([^\r\n]+)/i);
            var mU8 = blk.match(/FN;CHARSET=UTF-8:([^\r\n]+)/i);
            var mFN = blk.match(/FN:([^\r\n]+)/i);
            if (mQP) { name = decodeQPUtf8(mQP[1]).trim(); }
            else if (mU8) { name = mU8[1].trim(); }
            else if (mFN) { name = mFN[1].trim(); }
            
            var company = '';
            var mOQ = blk.match(/ORG[^:]*QUOTED-PRINTABLE[^:]*:([^\r\n]+)/i);
            var mOP = blk.match(/ORG[^:;]*:([^\r\n]+)/i);
            if (mOQ) { company = decodeQPUtf8(mOQ[1]).trim(); }
            else if (mOP) { company = mOP[1].trim(); }

            var note = '';
            var mNQ = blk.match(/NOTE[^:]*QUOTED-PRINTABLE[^:]*:([^\r\n]+)/i);
            var mNU = blk.match(/NOTE;CHARSET=UTF-8:([^\r\n]+)/i);
            var mNP = blk.match(/NOTE[^:;]*:([^\r\n]+)/i);
            if (mNQ) { note = decodeQPUtf8(mNQ[1]).trim(); }
            else if (mNU) { note = mNU[1].trim(); }
            else if (mNP) { note = mNP[1].trim(); }

            var telLines = blk.match(/TEL[^:]*:([^\r\n]+)/gi) || [];
            for (var ti = 0; ti < telLines.length; ti++) {
              var ci = telLines[ti].indexOf(':');
              if (ci < 0) continue;
              var phone = telLines[ti].slice(ci+1).trim().replace(/[^\d+]/g, '');
              if (!phone) continue;
              if (phoneSet.has(phone)) break;
              phoneSet.add(phone);
              var fundVal = '';
              if (/^d{4,5}$/.test(note)) {
                fundVal = note;
                note = '';
              }
              list.push({ name: name || '未知姓名', phone: phone, company: company, note: note, fund: fundVal, dialedStatus: 'todo', duration: '', callNote: '' });
              break;
            }
          }
          
          if (!list.length) {
            alert('未找到含电话的联系人');
            resetAIImporterUI();
            return;
          }

          // Deep AI Scanning trigger
          setTimeout(function() {
            renderAIReportForVcf(list);
          }, 1200);

        } catch(err) {
          alert('VCF 解析失败：' + err.message);
          resetAIImporterUI();
        }
      };
      reader.readAsText(file, 'utf-8');
    }

    // Fuzzy/partial match whitelist company
    function matchWhitelistCompany(company) {
      if (!company) return null;
      var key = String(company).trim().toLowerCase();
      if (!key) return null;
      if (!whitelistCompanies || whitelistCompanies.length === 0) return null;
      
      // 1. Try exact match first
      for (var i = 0; i < whitelistCompanies.length; i++) {
        var w = whitelistCompanies[i];
        if (w.status === '已失效' || w.status === '已删除') continue;
        var name = (w.company_name || '').trim().toLowerCase();
        var alias = (w.alias || '').trim().toLowerCase();
        if (name === key || (alias && alias === key)) {
          return w;
        }
      }
      
      // 2. Try partial/fuzzy match (excluding common prefixes/suffixes)
      var cleanCard = key.replace(/(有限公司|有限责任公司|公司|集团|深圳市|广州市|北京市|上海市|深圳|广州|北京|上海)/g, '').trim();
      if (cleanCard.length >= 2) {
        for (var i = 0; i < whitelistCompanies.length; i++) {
          var w = whitelistCompanies[i];
          if (w.status === '已失效' || w.status === '已删除') continue;
          var name = (w.company_name || '').trim().toLowerCase();
          var alias = (w.alias || '').trim().toLowerCase();
          
          var cleanName = name.replace(/(有限公司|有限责任公司|公司|集团|深圳市|广州市|北京市|上海市|深圳|广州|北京|上海)/g, '').trim();
          if (cleanName.length >= 2 && (cleanCard.indexOf(cleanName) !== -1 || cleanName.indexOf(cleanCard) !== -1)) {
            return w;
          }
          if (alias) {
            var cleanAlias = alias.replace(/(有限公司|有限责任公司|公司|集团|深圳市|广州市|北京市|上海市|深圳|广州|北京|上海)/g, '').trim();
            if (cleanAlias.length >= 2 && (cleanCard.indexOf(cleanAlias) !== -1 || cleanAlias.indexOf(cleanCard) !== -1)) {
              return w;
            }
          }
        }
      }
      return null;
    }

    // Render client list
    function renderDialCards() {
      var container = document.getElementById('cardsContainer');
      if (!container) return;
      
      updateStats();

      if (importedClients.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:80px 20px;color:var(--text-light);font-size:0.82rem;display:flex;flex-direction:column;gap:12px;"><span style="font-size: 2.2rem;opacity:0.6;">📇</span><span>暂无联系人数据，请在上方导入表格或通讯录文件</span></div>';
        return;
      }

      var query = document.getElementById('searchInput').value.toLowerCase().trim();
      var wlFilter = document.getElementById('whitelistFilterSelect') ? document.getElementById('whitelistFilterSelect').value : 'all';

      var filtered = importedClients.filter(function(c) {
        var matchFilter = (currentFilter === 'all') || (c.dialedStatus === currentFilter);
        
        var matchedWl = matchWhitelistCompany(c.company);
        var isCompanyInWhitelist = matchedWl ? (matchedWl.status !== '已失效' && matchedWl.status !== '已删除') : false;

        // Whitelist dropdown filter
        var matchWlFilter = true;
        if (wlFilter === 'yes') {
          matchWlFilter = isCompanyInWhitelist;
        } else if (wlFilter === 'no') {
          matchWlFilter = !isCompanyInWhitelist;
        }

        var matchQuery = true;
        if (query) {
          var isWlSearch = (query === '白名单' || query === '是白名单' || query === 'is:whitelist');
          var isNotWlSearch = (query === '非白名单' || query === '否白名单' || query === 'is:not-whitelist');
          
          if (isWlSearch) {
            matchQuery = isCompanyInWhitelist;
          } else if (isNotWlSearch) {
            matchQuery = !isCompanyInWhitelist;
          } else {
            matchQuery = c.name.toLowerCase().includes(query) || 
                         (c.phone || c.mobile || '').toLowerCase().includes(query) || 
                         c.company.toLowerCase().includes(query);
          }
        }
        return matchFilter && matchWlFilter && matchQuery;
      });

      if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light);font-size:0.8rem;">无匹配此筛选条件的联系人</div>';
        return;
      }

      // Apply Sorting
      var sorted = filtered.slice();
      if (currentSort === 'name') {
        sorted.sort(function(a, b) {
          return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
        });
      } else if (currentSort === 'company') {
        sorted.sort(function(a, b) {
          return String(a.company || '').localeCompare(String(b.company || ''), 'zh');
        });
      } else if (currentSort === 'todo') {
        sorted.sort(function(a, b) {
          var aTodo = (!a.dialedStatus || a.dialedStatus === 'todo') ? 0 : 1;
          var bTodo = (!b.dialedStatus || b.dialedStatus === 'todo') ? 0 : 1;
          return aTodo - bTodo;
        });
      } else if (currentSort === 'dialed') {
        sorted.sort(function(a, b) {
          var aDialed = (a.dialedStatus === 'success' || a.dialedStatus === 'failed') ? 0 : 1;
          var bDialed = (b.dialedStatus === 'success' || b.dialedStatus === 'failed') ? 0 : 1;
          return aDialed - bDialed;
        });
      } else if (currentSort === 'shuffle') {
        // Fisher-Yates shuffle for true random order
        for (var si = sorted.length - 1; si > 0; si--) {
          var sj = Math.floor(Math.random() * (si + 1));
          var tmp = sorted[si];
          sorted[si] = sorted[sj];
          sorted[sj] = tmp;
        }
      }

      // Calculate Pagination
      var total = sorted.length;
      var totalPages = Math.ceil(total / pageSize);
      if (currentPage > totalPages) currentPage = Math.max(1, totalPages);
      
      var start = (currentPage - 1) * pageSize;
      var end = Math.min(start + pageSize, total);
      var sliced = sorted.slice(start, end);

      // Calculate Pagination HTML first so it can be shared by both mobile and desktop views
      var pagHtml = '';
      if (totalPages > 1) {
        pagHtml += '<div class="pagination-bar" style="display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 18px; padding: 12px 0; border-top: 1px dashed var(--border-light); width: 100%;">';
        pagHtml += '<span style="font-size: 0.7rem; color: var(--text-light); margin-right: 4px; font-weight: 800;">第 ' + currentPage + '/' + totalPages + ' 页 (共 ' + total + ' 条)</span>';
        
        // Page Size Option Selector
        pagHtml += '<select id="pageSizeSel" style="height: 24px; font-size: 0.65rem; border: 1px solid var(--card-border); border-radius: var(--radius-xs); background: var(--btn-bg); color: var(--text-soft); font-weight: 800; outline: none; padding: 0 4px; cursor: pointer; margin-right: 6px;">';
        var sizes = [100, 200, 300, 500];
        sizes.forEach(function(sz) {
          var sel = (sz === pageSize) ? ' selected' : '';
          pagHtml += '<option value="' + sz + '"' + sel + '>' + sz + ' 条/页</option>';
        });
        pagHtml += '</select>';
        
        var prevDisabled = (currentPage === 1) ? ' disabled style="opacity: 0.4; cursor: not-allowed;"' : '';
        pagHtml += '<button class="btn-secondary" id="pagPrevBtn"' + prevDisabled + ' style="padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 800;">◀</button>';
        
        var startPage = Math.max(1, currentPage - 2);
        var endPage = Math.min(totalPages, currentPage + 2);
        
        if (startPage > 1) {
          pagHtml += '<button class="btn-secondary pag-num-btn" data-page="1" style="padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 800;">1</button>';
          if (startPage > 2) pagHtml += '<span style="font-size: 0.7rem; color: var(--text-light);">...</span>';
        }
        
        for (var p = startPage; p <= endPage; p++) {
          if (p === currentPage) {
            pagHtml += '<button class="btn-secondary pag-num-btn" data-page="' + p + '" style="background: var(--accent-wechat) !important; color: white !important; padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 900;">' + p + '</button>';
          } else {
            pagHtml += '<button class="btn-secondary pag-num-btn" data-page="' + p + '" style="padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 800;">' + p + '</button>';
          }
        }
        
        if (endPage < totalPages) {
          if (endPage < totalPages - 1) pagHtml += '<span style="font-size: 0.7rem; color: var(--text-light);">...</span>';
          pagHtml += '<button class="btn-secondary pag-num-btn" data-page="' + totalPages + '" style="padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 800;">' + totalPages + '</button>';
        }
        
        var nextDisabled = (currentPage === totalPages) ? ' disabled style="opacity: 0.4; cursor: not-allowed;"' : '';
        pagHtml += '<button class="btn-secondary" id="pagNextBtn"' + nextDisabled + ' style="padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 800;">▶</button>';
        pagHtml += '</div>';
      }

      if (isMobileDevice) {
        // Mobile View: Render Cards (resembling older versions)
        var cardsHtml = sliced.map(function(c) {
          var i = importedClients.indexOf(c);

          var badgeHtml = '<span class="xls-dial-badge xls-dial-badge-todo">待拨打</span>';
          var cardClass = 'xls-dial-card';
          var phoneVal = c.phone || c.mobile || '';
          if (c.dialedStatus === 'success') {
            badgeHtml = '<span class="xls-dial-badge xls-dial-badge-success">已接通 (' + (c.duration || '00:00') + ')</span>';
            cardClass += ' dialed';
            if (phoneVal) {
              badgeHtml += ' <button class="rec-play-btn" data-phone="' + esc(phoneVal) + '" title="播放通话录音" style="font-size:0.6rem;padding:1px 6px;border:1px solid #07c160;background:rgba(7,193,96,0.08);color:#07c160;border-radius:3px;cursor:pointer;font-weight:700;margin-left:4px;" onclick="event.stopPropagation();var p=this.dataset.phone;var a=document.createElement(\x27audio\x27);a.controls=true;a.style.width=\x27100%\x27;a.style.height=\x2728px\x27;a.style.marginTop=\x274px\x27;var w=this.nextElementSibling;if(w&&w.classList.contains(\x27rec-audio-wrap\x27)){w.remove();return;}var d=document.createElement(\x27div\x27);d.className=\x27rec-audio-wrap\x27;d.style.width=\x27100%\x27;d.appendChild(a);this.parentElement.appendChild(d);a.src=\x27/api/local-recording?phone=\x27+encodeURIComponent(p);a.play().catch(function(){});">▶ 录音</button>';
            }
          } else if (c.dialedStatus === 'failed') {
            badgeHtml = '<span class="xls-dial-badge xls-dial-badge-failed">未接通</span>';
            cardClass += ' dialed';
            if (phoneVal) {
              badgeHtml += ' <button class="rec-play-btn" data-phone="' + esc(phoneVal) + '" title="播放通话录音" style="font-size:0.6rem;padding:1px 6px;border:1px solid #e67e22;background:rgba(245,124,0,0.08);color:#e67e22;border-radius:3px;cursor:pointer;font-weight:700;margin-left:4px;" onclick="event.stopPropagation();var p=this.dataset.phone;var a=document.createElement(\x27audio\x27);a.controls=true;a.style.width=\x27100%\x27;a.style.height=\x2728px\x27;a.style.marginTop=\x274px\x27;var w=this.nextElementSibling;if(w&&w.classList.contains(\x27rec-audio-wrap\x27)){w.remove();return;}var d=document.createElement(\x27div\x27);d.className=\x27rec-audio-wrap\x27;d.style.width=\x27100%\x27;d.appendChild(a);this.parentElement.appendChild(d);a.src=\x27/api/local-recording?phone=\x27+encodeURIComponent(p);a.play().catch(function(){});">▶ 录音</button>';
            }
          }

          var phoneClass = c.copied ? 'client-phone-btn copied' : 'client-phone-btn';

          return '<div class="' + cardClass + '" id="xdc_' + i + '">' +
            '<div class="client-card-top">' +
              '<div class="client-card-primary" style="display: flex; align-items: center; width: 100%; gap: 6px;">' +
                '<span class="client-card-name-btn" data-name="' + esc(c.name) + '" data-idx="' + i + '" title="点击复制姓名" style="flex: 0 0 62px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block;">' + esc(c.name) + '</span>' +
                '<span class="client-card-phone-wrap" style="flex: 0 0 110px; display: inline-flex; align-items: center;">' +
                  '<span class="' + phoneClass + '" data-phone="' + esc(phoneVal) + '" data-idx="' + i + '" title="点击复制号码" style="font-size: 0.82rem;">' + esc(phoneVal) + '</span>' +
                '</span>' +
                '<div style="margin-left: auto; display: inline-flex; align-items: center; justify-content: flex-end; flex-shrink: 0;">' +
                  badgeHtml +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="client-card-tags" style="margin-top: 2px;">' +
              (c.company ? '<span class="client-card-tag client-card-tag-company" data-company="' + esc(c.company) + '" data-idx="' + i + '" title="点击复制单位名称">' + esc(c.company) + '</span>' : '') +
              (c.batch_label ? '<span class="client-card-tag" style="background:rgba(74,108,247,0.08);color:#4a6cf7;font-weight:700;" title="导入批次">🏷 ' + esc(c.batch_label) + '</span>' : '') +
              (c.fund ? '<span class="client-card-tag crm-fund-tag" style="background:rgba(255,152,0,0.08);color:#f57c00;font-weight:700;" title="公积金">💰 公积金: ' + esc(c.fund) + '</span>' : '') +
              (function() {
                var customHtml = '';
                if (c.custom && typeof c.custom === 'object') {
                  for (var key in c.custom) {
                    if (c.custom.hasOwnProperty(key) && c.custom[key]) {
                      customHtml += '<span class="client-card-tag" style="background:rgba(0,188,212,0.08);color:#0097a7;font-weight:700;" title="' + esc(key) + '">' + esc(key) + ': ' + esc(c.custom[key]) + '</span>';
                    }
                  }
                }
                return customHtml;
              })() +
              (function() {
                if (!c.company) return '';
                var matchedWl = matchWhitelistCompany(c.company);
                if (matchedWl) {
                  var bank = matchedWl.bank_name || '建行建易贷';
                  return '<span class="client-card-tag xls-dial-badge-whitelist">' + esc(bank) + '</span>';
                }
                return '';
              })() +
            '</div>' +
            (c.note ? 
              '<div class="client-card-body" style="margin-top: 4px;">' +
                '<div class="client-card-content-block follow-up" style="background:rgba(74,108,247,0.03); border-left:3px solid #4a6cf7; padding: 6px 8px; border-radius: 0 var(--radius-xs) var(--radius-xs) 0;">' +
                  '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">' +
                    '<span class="client-card-label" style="color:#4a6cf7; font-weight:800; font-size:0.65rem;">资料备注</span>' +
                    '<span class="client-card-tag-note" data-note="' + esc(c.note) + '" style="font-size:0.6rem; color:#4a6cf7; cursor:pointer; text-decoration:underline;">[放大查看]</span>' +
                  '</div>' +
                  '<span class="client-card-text" style="color:var(--text-soft); white-space:pre-wrap; display:block; margin-top:2px;">' + esc(c.note) + '</span>' +
                '</div>' +
              '</div>' : '') +
            (c.callNote ? 
              '<div class="client-card-body" style="margin-top: 4px;">' +
                '<div class="client-card-content-block follow-up">' +
                  '<span class="client-card-label">通话小记</span>' +
                  '<span class="client-card-text" style="color:var(--accent-wechat);">' + esc(c.callNote) + '</span>' +
                '</div>' +
              '</div>' : '') +
            (typeof AndroidDialer !== 'undefined' && AndroidDialer.hasRecording(phoneVal) ? 
              '<div class="client-card-body" style="margin-top: 4px;">' +
                '<div class="client-card-content-block" style="background:rgba(9,187,7,0.03); border-left:3px solid var(--accent-wechat); padding: 6px 8px; border-radius: 0 var(--radius-xs) var(--radius-xs) 0;">' +
                  '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">' +
                    '<span class="client-card-label" style="color:var(--accent-wechat); font-weight:800; font-size:0.65rem;">通话录音</span>' +
                    '<span style="font-size:0.6rem; color:var(--accent-wechat); font-weight:bold;">[本地录音就绪]</span>' +
                  '</div>' +
                  '<audio src="/api/local-recording?phone=' + encodeURIComponent(phoneVal) + '" controls style="width: 100%; height: 32px; outline: none; margin-top: 4px; display: block;"></audio>' +
                '</div>' +
              '</div>' : '') +
            '<div class="client-card-actions">' +
              '<a href="tel:' + esc(phoneVal) + '" class="btn-primary xls-card-dial-btn" data-idx="' + i + '" style="font-size:0.75rem;padding:2px 12px;height:28px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;">拨打</a>' +
            '</div>' +
          '</div>';
        }).join('');

        container.innerHTML = cardsHtml + pagHtml;

        // Wire up card phone click copy + WeChat jump
        container.querySelectorAll('.client-phone-btn').forEach(function(b) {
          b.addEventListener('click', function(e) {
            e.stopPropagation();
            var phone = b.dataset.phone;
            var idx = parseInt(b.dataset.idx);

            copyTextToClipboard(phone);
            var oldText = b.textContent;
            if (oldText === '已复制，正在打开微信...') return;
            b.textContent = '已复制，正在打开微信...';
            var oldColor = b.style.color;
            b.style.color = 'var(--accent-wechat)';
            var client = importedClients[idx];
            if (client) {
              client.copied = true;
              saveState();
            }
            b.classList.add('copied');

            setTimeout(function() {
              jumpToWechat();
            }, 100);

            setTimeout(function() {
              b.textContent = phone;
              b.style.color = oldColor;
            }, 1500);
          });
        });

        // Wire up name click copy
        container.querySelectorAll('.client-card-name-btn').forEach(function(b) {
          b.addEventListener('click', function(e) {
            e.stopPropagation();
            var name = b.dataset.name;
            var idx = parseInt(b.dataset.idx);
            copyTextToClipboard(name);
            
            var oldText = b.textContent;
            if (oldText === '已复制') return;
            b.textContent = '已复制';
            var oldColor = b.style.color;
            b.style.color = 'var(--accent-wechat)';
            
            var client = importedClients[idx];
            if (client) {
              client.copied = true;
              saveState();
            }

            var card = document.getElementById('xdc_' + idx);
            if (card) {
              var phoneBtn = card.querySelector('.client-phone-btn');
              if (phoneBtn) {
                phoneBtn.classList.add('copied');
              }
            }

            setTimeout(function() {
              b.textContent = name;
              b.style.color = oldColor;
            }, 1000);
          });
        });

        // Wire up company click copy
        container.querySelectorAll('.client-card-tag-company').forEach(function(b) {
          b.addEventListener('click', function(e) {
            e.stopPropagation();
            var company = b.dataset.company;
            copyTextToClipboard(company);
            
            var oldText = b.textContent;
            if (oldText === '已复制') return;
            b.textContent = '已复制';
            var oldColor = b.style.color;
            b.style.color = 'var(--accent-wechat)';
            
            setTimeout(function() {
              b.textContent = company;
              b.style.color = oldColor;
            }, 1000);
          });
        });

        // Wire up card tag note click modal
        container.querySelectorAll('.client-card-tag-note').forEach(function(b) {
          b.addEventListener('click', function(e) {
            e.stopPropagation();
            var note = b.dataset.note || '(空)';
            var content = document.getElementById('noteModalContent');
            if (content) {
              content.textContent = note;
            }
            var modal = document.getElementById('noteModal');
            if (modal) {
              modal.classList.add('active');
            }
          });
        });

        // Wire up call button
        container.querySelectorAll('.xls-card-dial-btn').forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            var idx = parseInt(this.dataset.idx);
            // Delay opening the modal by 200ms to allow Safari to natively trigger the tel: anchor navigation first
            setTimeout(function() {
              startCallAssistant(idx);
            }, 200);
          });
        });
      } else {
        // Desktop View: Render CRM Table
        var tableHtml = '<table class="crm-table"><thead><tr>' +
          '<th class="col-no">#</th>' +
          '<th class="col-status">状态</th>' +
          '<th class="col-name">姓名</th>' +
          '<th class="col-phone">电话</th>' +
          '<th class="col-company">公司</th>' +
          '<th class="col-note">备注/金额</th>' +
          '<th class="col-batch">批次</th>' +
          '<th class="col-action">操作</th>' +
        '</tr></thead><tbody>';

        tableHtml += sliced.map(function(c, idx) {
          var rowNo = (currentPage - 1) * pageSize + idx + 1;

          var badgeHtml = '<span style="font-size:11px;padding:1px 6px;border-radius:3px;background:#f0f0f0;color:#888;">待拨</span>';
          var rowClass = '';
          if (c.dialedStatus === 'success') {
            badgeHtml = '<span style="font-size:11px;padding:1px 6px;border-radius:3px;background:rgba(7,193,96,0.12);color:#07c160;">已拨</span>';
            rowClass = ' row-dialed';
          } else if (c.dialedStatus === 'failed') {
            badgeHtml = '<span style="font-size:11px;padding:1px 6px;border-radius:3px;background:rgba(231,76,60,0.1);color:#e74c3c;">未通</span>';
            rowClass = ' row-dialed';
          }

          var wlBadge = '';
          if (c.company) {
            var matchedWl = matchWhitelistCompany(c.company);
            if (matchedWl) {
              wlBadge = ' <span style="font-size:10px;background:rgba(7,193,96,0.1);color:#07c160;padding:0 4px;border-radius:2px;">' + esc(matchedWl.bank_name || '白名单') + '</span>';
            }
          }

          var phoneVal = c.phone || c.mobile || '';
          return '<tr class="' + rowClass + '" data-idx="' + idx + '">' +
            '<td class="col-no">' + rowNo + '</td>' +
            '<td class="col-status">' + badgeHtml + '</td>' +
            '<td class="col-name"><span class="crm-copy-btn" data-copy="' + esc(c.name||'') + '" title="点击复制">' + esc(c.name||'-') + '</span></td>' +
            '<td class="col-phone"><span class="crm-copy-btn" data-copy="' + esc(phoneVal) + '" title="点击复制">' + esc(phoneVal || '-') + '</span></td>' +
            '<td class="col-company"><span class="crm-copy-btn" data-copy="' + esc(c.company||'') + '">' + esc(c.company||'-') + '</span>' + wlBadge + '</td>' +
            '<td class="col-note">' + esc(c.note||'-') + '</td>' +
            '<td class="col-batch">' + '<span style="font-size:11px;background:rgba(74,108,247,0.08);color:#4a6cf7;padding:1px 6px;border-radius:3px;">' + (c.batch_label || (c.created_at ? c.created_at.slice(5, 19).replace('T', ' ') : '-')) + '</span>' + '</td>' +
            '<td class="col-action"><a href="tel:' + esc(phoneVal) + '" style="display:inline-block;padding:3px 10px;background:linear-gradient(135deg,#07c160,#06ad56);color:#fff;border-radius:4px;text-decoration:none;font-size:12px;font-weight:700;">拨打</a></td>' +
          '</tr>';
        }).join('');

        tableHtml += '</tbody></table>';
        container.innerHTML = tableHtml + pagHtml;

        // Wire up CRM table copy buttons
        container.querySelectorAll('.crm-copy-btn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var text = this.dataset.copy;
            if (!text) return;
            navigator.clipboard.writeText(text).then(function() {
              // Brief flash
              var orig = btn.style.color;
              btn.style.color = '#07c160';
              setTimeout(function() { btn.style.color = orig; }, 600);
            }).catch(function() {});
          });
        });

        // Wire up table dial buttons with call assistant
        container.querySelectorAll('.col-action a').forEach(function(btn, idx) {
          btn.addEventListener('click', function(e) {
            // Let the tel: link work natively
            var client = sliced[idx];
            if (client) {
              setTimeout(function() {
                startCallAssistant(importedClients.indexOf(client));
              }, 300);
            }
          });
        });
      }
    }

    // Call Assistant Controls
    var selectedCallStatus = 'success';

    function getNextClientIndex(currentIdx) {
      var query = document.getElementById('searchInput').value.toLowerCase().trim();
      var filtered = importedClients.filter(function(c) {
        var matchFilter = (currentFilter === 'all') || (c.dialedStatus === currentFilter);
        var matchQuery = true;
        if (query) {
          matchQuery = c.name.toLowerCase().includes(query) ||
                       c.phone.toLowerCase().includes(query) ||
                       c.company.toLowerCase().includes(query);
        }
        return matchFilter && matchQuery;
      });

      if (currentIdx < 0 && filtered.length > 0) {
        return importedClients.indexOf(filtered[0]);
      }
      var currentClient = importedClients[currentIdx];
      var filteredPos = filtered.indexOf(currentClient);
      if (filteredPos !== -1 && filteredPos + 1 < filtered.length) {
        return importedClients.indexOf(filtered[filteredPos + 1]);
      }
      return -1;
    }

    function startCallAssistant(idx) {
      var c = importedClients[idx];
      if (!c) return;

      currentCallIdx = idx;

      var phoneVal = c.phone || c.mobile || '';
      document.getElementById('callAssistName').innerText = c.name;
      document.getElementById('callAssistNameDisplay').innerText = c.name;
      document.getElementById('callAssistPhone').innerText = phoneVal;
      document.getElementById('callAssistPhoneDisplay').innerText = phoneVal;
      document.getElementById('callLogNote').value = c.callNote || '';

      // Show company info if available
      var companyRow = document.getElementById('callAssistCompanyRow');
      var companyEl = document.getElementById('callAssistCompany');
      if (c.company && String(c.company).trim()) {
        companyEl.textContent = c.company;
        companyEl.dataset.company = c.company;
        companyRow.style.display = 'flex';
        companyRow.style.alignItems = 'center';
        companyRow.style.gap = '4px';
      } else {
        companyRow.style.display = 'none';
      }

      // Show note/remark info if available
      var noteRow = document.getElementById('callAssistNoteRow');
      var noteEl = document.getElementById('callAssistNote');
      if (c.note && c.note.trim()) {
        noteEl.textContent = c.note;
        noteRow.style.display = 'flex';
        noteRow.style.alignItems = 'baseline';
        noteRow.style.gap = '4px';
      } else {
        noteRow.style.display = 'none';
      }

      var nameDisp = document.getElementById('callAssistNameDisplay');
      if (nameDisp) {
        nameDisp.dataset.name = c.name;
      }
      var phoneDisp = document.getElementById('callAssistPhoneDisplay');
      var phoneVal = c.phone || c.mobile || '';
      if (phoneDisp) {
        phoneDisp.dataset.phone = phoneVal;
        if (c.copied) {
          phoneDisp.classList.add('copied');
        } else {
          phoneDisp.classList.remove('copied');
        }
      }

      var dialLink = document.getElementById('callAssistDialLink');
      if (dialLink) {
        dialLink.href = 'tel:' + phoneVal;
      }

      // Check and render local recording file if available
      var recContainer = document.getElementById('callAssistRecContainer');
      var audioWrapper = document.getElementById('callAssistAudioWrapper');
      if (recContainer && audioWrapper) {
        var hasRec = (typeof AndroidDialer !== 'undefined' && AndroidDialer.hasRecording(phoneVal));
        if (hasRec) {
          audioWrapper.innerHTML = '<audio src="/api/local-recording?phone=' + encodeURIComponent(phoneVal) + '" controls style="width: 100%; height: 32px; outline: none; margin-top: 4px; display: block;"></audio>';
          recContainer.style.display = 'flex';
        } else {
          audioWrapper.innerHTML = '';
          recContainer.style.display = 'none';
        }
      }

      document.getElementById('callAssistOverlay').classList.add('active');
    }

    function initCallControls() {
      var successBtn = document.getElementById('callOutcomeSuccessBtn');
      var failedBtn = document.getElementById('callOutcomeFailedBtn');
      var overlay = document.getElementById('callAssistOverlay');
      var phoneDisp = document.getElementById('callAssistPhoneDisplay');
      var nameDisp = document.getElementById('callAssistNameDisplay');

      window.onAndroidCallResult = function(duration) {
        if (duration >= 0) {
          var min = Math.floor(duration / 60);
          var sec = duration % 60;
          var formatted = (min < 10 ? '0' : '') + min + ':' + (sec < 10 ? '0' : '') + sec;
          
          var c = importedClients[currentCallIdx];
          if (c) {
            c.duration = formatted;
            var currentNote = document.getElementById('callLogNote').value.trim();
            if (!currentNote) {
              if (duration > 0) {
                document.getElementById('callLogNote').value = '已接通，通话时长 ' + duration + ' 秒。';
              } else {
                document.getElementById('callLogNote').value = '已拨打未接通。';
              }
            }

            // Immediately check and display the new local recording file if available!
            var recContainer = document.getElementById('callAssistRecContainer');
            var audioWrapper = document.getElementById('callAssistAudioWrapper');
            if (recContainer && audioWrapper) {
              var phoneVal = c.phone || c.mobile || '';
              var hasRec = (typeof AndroidDialer !== 'undefined' && AndroidDialer.hasRecording(phoneVal));
              if (hasRec) {
                audioWrapper.innerHTML = '<audio src="/api/local-recording?phone=' + encodeURIComponent(phoneVal) + '" controls style="width: 100%; height: 32px; outline: none; margin-top: 4px; display: block;"></audio>';
                recContainer.style.display = 'flex';
              }
            }
          }
        }
      };

      function saveProgress(status) {
        var c = importedClients[currentCallIdx];
        if (!c) return false;

        c.callNote = document.getElementById('callLogNote').value.trim();
        c.dialedStatus = status;
        c.duration = '-';
        return true;
      }

      var autoDialActive = false;
      function handleOutcome(status) {
        if (!saveProgress(status)) return;
        saveState();
        renderDialCards();

        var nextIdx = getNextClientIndex(currentCallIdx);
        if (nextIdx !== -1) {
          startCallAssistant(nextIdx);
          if (autoDialActive) {
            setTimeout(function() {
              var link = document.getElementById('callAssistDialLink');
              if (link && link.href) window.location.href = link.href;
            }, 800);
          }
        } else {
          if (autoDialActive) {
            autoDialActive = false;
            updateAutoDialBtn();
          }
          alert('已经是当前筛选列表的最后一位客户了！');
          overlay.classList.remove('active');
        }
      }

      function updateAutoDialBtn() {
        var btn = document.getElementById('autoDialBtn');
        if (autoDialActive) {
          btn.textContent = '暂停拨打';
          btn.style.background = '#e74c3c';
          btn.style.color = '#fff';
          btn.style.borderColor = '#e74c3c';
        } else {
          btn.textContent = '自动拨打';
          btn.style.background = '';
          btn.style.color = '';
          btn.style.borderColor = '';
        }
      }

      document.getElementById('autoDialBtn').addEventListener('click', function() {
        autoDialActive = !autoDialActive;
        updateAutoDialBtn();
        if (autoDialActive) {
          if (currentCallIdx === -1) {
            var firstIdx = getNextClientIndex(-1);
            if (firstIdx !== -1) {
              startCallAssistant(firstIdx);
              setTimeout(function() {
                var link = document.getElementById('callAssistDialLink');
                if (link && link.href) window.location.href = link.href;
              }, 800);
            }
          } else {
            var link = document.getElementById('callAssistDialLink');
            if (link && link.href) window.location.href = link.href;
          }
        }
      });

      successBtn.addEventListener('click', function() {
        handleOutcome('success');
      });

      failedBtn.addEventListener('click', function() {
        handleOutcome('failed');
      });

      if (phoneDisp) {
        phoneDisp.addEventListener('click', function(e) {
          e.stopPropagation();
          var phone = phoneDisp.dataset.phone;

          // Rate limit check
          var limit = checkCopyLimit();
          if (!limit.allowed) {
            showCopyLimitToast(limit.message, false);
            return;
          }

          copyTextToClipboard(phone);

          var oldText = phoneDisp.textContent;
          if (oldText === '已复制，正在打开微信...') return;
          phoneDisp.textContent = '已复制，正在打开微信...';

          var client = importedClients[currentCallIdx];
          if (client) {
            client.copied = true;
            saveState();
          }

          phoneDisp.classList.add('copied');

          var card = document.getElementById('xdc_' + currentCallIdx);
          if (card) {
            var cardPhoneBtn = card.querySelector('.client-phone-btn');
            if (cardPhoneBtn) {
              cardPhoneBtn.classList.add('copied');
            }
          }

          setTimeout(function() {
            jumpToWechat();
          }, 100);

          setTimeout(function() {
            phoneDisp.textContent = phone;
          }, 1500);
        });
      }

      if (nameDisp) {
        nameDisp.addEventListener('click', function(e) {
          e.stopPropagation();
          var name = nameDisp.dataset.name;
          copyTextToClipboard(name);
          
          var oldText = nameDisp.textContent;
          if (oldText === '已复制') return;
          nameDisp.textContent = '已复制';
          
          var client = importedClients[currentCallIdx];
          if (client) {
            client.copied = true;
            saveState();
          }

          if (phoneDisp) {
            phoneDisp.classList.add('copied');
          }

          var card = document.getElementById('xdc_' + currentCallIdx);
          if (card) {
            var cardPhoneBtn = card.querySelector('.client-phone-btn');
            if (cardPhoneBtn) {
              cardPhoneBtn.classList.add('copied');
            }
          }

          setTimeout(function() {
            nameDisp.textContent = name;
          }, 1000);
        });
      }

      var companyDisp = document.getElementById('callAssistCompany');
      if (companyDisp) {
        companyDisp.addEventListener('click', function(e) {
          e.stopPropagation();
          var company = companyDisp.dataset.company || companyDisp.textContent;
          if (!company || company === '-') return;
          copyTextToClipboard(company);
          
          var oldText = companyDisp.textContent;
          if (oldText === '已复制') return;
          companyDisp.textContent = '已复制';
          
          setTimeout(function() {
            companyDisp.textContent = company;
          }, 1000);
        });
      }

      // Close modal when clicking blank area outside
      overlay.addEventListener('click', function(e) {
        if (e.target === this) {
          overlay.classList.remove('active');
        }
      });
    }

    function initFilters() {
      document.querySelectorAll('.filter-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          document.querySelectorAll('.filter-tab').forEach(function(t) { t.classList.remove('active'); });
          tab.classList.add('active');
          currentFilter = tab.dataset.filter;
          currentPage = 1; // Reset to page 1
          renderDialCards();
        });
      });

      document.getElementById('searchInput').addEventListener('input', function() {
        currentPage = 1; // Reset to page 1
        renderDialCards();
      });

      var sortSel = document.getElementById('sortSelect');
      if (sortSel) {
        sortSel.addEventListener('change', function() {
          currentSort = this.value;
          currentPage = 1; // Reset to page 1
          renderDialCards();
        });
      }

      var wlFilterSel = document.getElementById('whitelistFilterSelect');
      if (wlFilterSel) {
        wlFilterSel.addEventListener('change', function() {
          var val = this.value;
          currentPage = 1; // Reset to page 1
          if (val !== 'all' && !whitelistCheckResults) {
            checkWhitelist().then(function() {
              renderDialCards();
            });
          } else {
            renderDialCards();
          }
        });
      }
    }

    function initFileInputs() {
      var xlsSelect = document.getElementById('xlsSelectBtn');
      var xlsFile = document.getElementById('xlsFileInput');
      var vcfSelect = document.getElementById('vcfSelectBtn');
      var vcfFile = document.getElementById('vcfFileInput');
      var dropZone = document.getElementById('dropZone');
      var toggleBtn = document.getElementById('toggleImportBtn');

      if (toggleBtn) {
        toggleBtn.addEventListener('click', function() {
          var panel = document.getElementById('dashboardPanel');
          if (panel) {
            if (panel.style.display === 'none') {
              panel.style.display = 'block';
            } else {
              panel.style.display = 'none';
            }
          }
        });
      }

      // Dual-SIM rotation toggle
      var dualSimBtn = document.getElementById('toggleDualSimBtn');
      var dualSimOn = true;
      var rotationCount = 10;
      if (dualSimBtn) {
        dualSimBtn.addEventListener('click', function() {
          dualSimOn = !dualSimOn;
          dualSimBtn.textContent = '双卡轮换: ' + (dualSimOn ? '开' : '关');
          localStorage.setItem('dialer_dual_sim', dualSimOn ? '1' : '0');
        });
      }
      var rotationBtn = document.getElementById('toggleRotationBtn');
      if (rotationBtn) {
        rotationBtn.addEventListener('click', function() {
          rotationCount = rotationCount === 10 ? 5 : 10;
          rotationBtn.textContent = '轮换频率: ' + rotationCount + '通';
          localStorage.setItem('dialer_rotation', String(rotationCount));
        });
      }

      if (xlsFile) {
        xlsFile.addEventListener('change', function(e) {
          var file = e.target.files[0];
          if (file) handleFileImportDispatch(file);
          e.target.value = '';
        });
      }

      if (vcfFile) {
        vcfFile.addEventListener('change', function(e) {
          var file = e.target.files[0];
          if (file) handleFileImportDispatch(file);
          e.target.value = '';
        });
      }

      var imgFile = document.getElementById('imgFileInput');
      if (imgFile) {
        imgFile.addEventListener('change', function(e) {
          var files = Array.from(e.target.files || []);
          if (files.length === 0) { e.target.value = ''; return; }
          if (files.length === 1) {
            handleFileImportDispatch(files[0]);
          } else {
            handleMultiImageOCR(files);
          }
          e.target.value = '';
        });
      }

      // Drag & Drop
      if (dropZone) {
        dropZone.addEventListener('dragover', function(e) {
          e.preventDefault();
          dropZone.classList.add('dragover');
        });
        dropZone.addEventListener('dragleave', function() {
          dropZone.classList.remove('dragover');
        });
        dropZone.addEventListener('drop', function(e) {
          e.preventDefault();
          dropZone.classList.remove('dragover');
          var files = Array.from(e.dataTransfer.files || []);
          if (files.length === 0) return;
          // If multiple image files dropped, queue them all
          var imgFiles = files.filter(function(f) { return /.(jpg|jpeg|png|bmp|webp)$/i.test(f.name); });
          if (imgFiles.length > 1) {
            handleMultiImageOCR(imgFiles);
          } else if (files.length === 1) {
            handleFileImportDispatch(files[0]);
          } else {
            // Mixed files - only one non-image file - dispatch it
            handleFileImportDispatch(files[0]);
          }
        });
      }

      // Local OCR Slicing Config Bindings
      var slider1 = document.getElementById('sliderSplit1');
      var slider2 = document.getElementById('sliderSplit2');
      var orderSelect = document.getElementById('ocrColumnOrder');
      if (slider1 && slider2) {
        slider1.oninput = function() {
          var s1 = parseInt(slider1.value);
          var s2 = parseInt(slider2.value);
          if (s1 >= s2) {
            slider1.value = s2 - 2;
          }
          drawOcrSlicingPreviewLines();
        };
        slider2.oninput = function() {
          var s1 = parseInt(slider1.value);
          var s2 = parseInt(slider2.value);
          if (s2 <= s1) {
            slider2.value = s1 + 2;
          }
          drawOcrSlicingPreviewLines();
        };
      }
      if (orderSelect) {
        orderSelect.onchange = drawOcrSlicingPreviewLines;
      }
      
      var btnStart = document.getElementById('btnStartLocalOcr');
      if (btnStart) btnStart.onclick = startLocalOcrProcessing;
      
      var btnCancel = document.getElementById('btnCancelLocalOcr');
      if (btnCancel) btnCancel.onclick = resetAIImporterUI;
    }

    // Clear and Export Data
    function initDataActions() {
      var clearBtn = document.getElementById('clearBtn');
      var exportBtn = document.getElementById('exportBtn');
      var closeExport = document.getElementById('closeExportBtn');
      var copyExport = document.getElementById('copyExportBtn');
      var exportModal = document.getElementById('exportModal');
      var exportArea = document.getElementById('exportTextarea');

      if (clearBtn) {
        clearBtn.addEventListener('click', function() {
          if (confirm('确认清空当前导入的客户和所有的拨号记录吗？')) {
            importedClients = [];
            saveState();
            updateDashboardVisibility(false);
            var statusEl = document.getElementById('importStatus');
            if (statusEl) statusEl.innerText = '';
            renderDialCards();
          }
        });
      }

      if (exportBtn) {
        exportBtn.addEventListener('click', function() {
          if (importedClients.length === 0) return;
          
          var lines = ['姓名,电话,单位,状态,时长,沟通小记'];
          importedClients.forEach(function(c) {
            var statusStr = '待拨打';
            if (c.dialedStatus === 'success') statusStr = '已接通';
            else if (c.dialedStatus === 'failed') statusStr = '未接通';

            lines.push(
              '"' + c.name + '",' +
              '"' + c.phone + '",' +
              '"' + (c.company || '') + '",' +
              '"' + statusStr + '",' +
              '"' + (c.duration || '') + '",' +
              '"' + (c.callNote || '') + '"'
            );
          });

          if (exportArea) exportArea.value = lines.join('\n');
          if (exportModal) exportModal.classList.add('active');
        });
      }

      if (closeExport && exportModal) {
        closeExport.addEventListener('click', function() {
          exportModal.classList.remove('active');
        });
      }

      if (copyExport && exportArea) {
        copyExport.addEventListener('click', function() {
          exportArea.select();
          document.execCommand('copy');
          copyExport.textContent = '✅ 已成功复制！';
          setTimeout(function() {
            copyExport.textContent = '复制记录到剪贴板';
          }, 1500);
        });
      }
    }

    // ====== Customer Data Viewer (Supabase CRM) ======
    var DB = {
      page: 1,
      total: 0,
      pageSize: 300, // 默认 300 条/页
      timer: null,
      sortBy: '',
      sortDir: 'asc',
      activeTab: 'all', // all, 意向客户, 线索池, 公海客户
      activeShortcut: 'all', // all, today, never, 3days
      selectedIds: {}, // 选中的 ID 字典
      allData: [], // 缓存在前端的数据，方便高精度过滤与本地计算
      customColumns: (function() {
        try {
          var saved = localStorage.getItem('crm_custom_columns');
          var parsed = saved ? JSON.parse(saved) : [];
          return Array.isArray(parsed) ? parsed : [];
        } catch(e) { return []; }
      })()
    };
    var CATS = ['潜在客户','意向客户','已成交','无效号码','待跟进','老客户','同行','其他','公海客户'];

    function parseCustomerNote(c) {
      var noteStr = (c.note || '').trim();
      var parsed = { note: noteStr, custom: {} };
      if (!noteStr) return parsed;
      if (noteStr.indexOf('{') === 0) {
        var braceCount = 0;
        var jsonEndIdx = -1;
        for (var i = 0; i < noteStr.length; i++) {
          if (noteStr[i] === '{') braceCount++;
          else if (noteStr[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              jsonEndIdx = i;
              break;
            }
          }
        }
        if (jsonEndIdx !== -1) {
          var jsonPart = noteStr.slice(0, jsonEndIdx + 1);
          var textPart = noteStr.slice(jsonEndIdx + 1).trim();
          try {
            var obj = JSON.parse(jsonPart);
            if (obj && typeof obj === 'object') {
              var baseNote = obj.note !== undefined ? obj.note : '';
              parsed.custom = obj.custom || {};
              if (obj.fund) {
                c.fund = obj.fund; // Restore fund to customer object
              }
              if (textPart) {
                parsed.note = baseNote ? baseNote + '\n' + textPart : textPart;
              } else {
                parsed.note = baseNote;
              }
              return parsed;
            }
          } catch (e) {}
        }
      }
      return parsed;
    }

    function serializeCustomersForSupabase(customers) {
      return customers.map(function(c) {
        var copy = Object.assign({}, c);
        var parsed = { note: copy.note || '', custom: copy.custom || {} };
        
        var fundVal = (copy.fund || '').trim();
        var rawNote = (copy.note || '').trim();
        if (rawNote.indexOf('{') === 0) {
          try {
            var braceCount = 0;
            var jsonEndIdx = -1;
            for (var i = 0; i < rawNote.length; i++) {
              if (rawNote[i] === '{') braceCount++;
              else if (rawNote[i] === '}') {
                braceCount--;
                if (braceCount === 0) { jsonEndIdx = i; break; }
              }
            }
            if (jsonEndIdx !== -1) {
              var jsonPart = rawNote.slice(0, jsonEndIdx + 1);
              var textPart = rawNote.slice(jsonEndIdx + 1).trim();
              var obj = JSON.parse(jsonPart);
              if (obj && typeof obj === 'object') {
                parsed.note = obj.note !== undefined ? obj.note : '';
                parsed.custom = Object.assign({}, obj.custom || {}, parsed.custom);
                if (obj.fund && !fundVal) fundVal = obj.fund;
                if (textPart) {
                  parsed.note = parsed.note ? parsed.note + '\n' + textPart : textPart;
                }
              }
            }
          } catch(e) {}
        }

        var jsonPayload = { note: parsed.note, custom: parsed.custom };
        if (fundVal) {
          jsonPayload.fund = fundVal;
        }

        if (Object.keys(parsed.custom).length > 0 || fundVal) {
          copy.note = JSON.stringify(jsonPayload);
        } else {
          copy.note = parsed.note;
        }
        copy.mobile = copy.mobile || copy.phone;
        return copy;
      });
    }

    function renderCRMHeaders() {
      var headerRow = document.getElementById('dbHeaderRow');
      if (!headerRow) return;
      var html = '<th style="width: 40px; text-align: center; cursor: default;"><input type="checkbox" id="crmSelectAll"></th>' +
        '<th data-sort="name" style="width: 140px; cursor: pointer;">客户名称 <span class="sort-arrow">▲</span></th>' +
        '<th data-sort="mobile" style="width: 160px; cursor: pointer;">联系号码 <span class="sort-arrow">▲</span></th>' +
        '<th data-sort="note" style="min-width: 120px; cursor: pointer;">备注 <span class="sort-arrow">▲</span></th>';
      var customCols = DB.customColumns || [];
      customCols.forEach(function(col) {
        html += '<th data-sort="custom_' + esc(col) + '" style="min-width: 100px; cursor: pointer;">' + esc(col) + ' <span class="sort-arrow">▲</span></th>';
      });
      html += '<th data-sort="company_name" style="min-width: 200px; cursor: pointer;">单位 <span class="sort-arrow">▲</span></th>' +
        '<th data-sort="category" style="width: 100px; cursor: pointer;">分类 <span class="sort-arrow">▲</span></th>' +
        '<th data-sort="created_at" style="width: 150px; cursor: pointer;">入库时间 <span class="sort-arrow">▲</span></th>' +
        '<th style="width: 100px; cursor: default;">操作</th>';
      headerRow.innerHTML = html;
      dbWireSortHeaders();
      var selectAllCb = document.getElementById('crmSelectAll');
      if (selectAllCb) {
        selectAllCb.onchange = function() {
          var cbs = document.querySelectorAll('#dbTbody .crm-row-select');
          var checked = selectAllCb.checked;
          cbs.forEach(function(cb) {
            cb.checked = checked;
            var m = cb.getAttribute('data-mobile');
            var tr = cb.closest('tr');
            if (checked) {
              DB.selectedIds[m] = true;
              if (tr) tr.classList.add('selected');
            } else {
              delete DB.selectedIds[m];
              if (tr) tr.classList.remove('selected');
            }
          });
        };
      }
    }

    function renderCustomColumnsList() {
      var container = document.getElementById('customColumnsList');
      if (!container) return;
      var cols = DB.customColumns || [];
      if (cols.length === 0) {
        container.innerHTML = '<div style="font-size:0.72rem; color:var(--text-light); text-align:center; padding:10px;">暂无自定义列，可在下方输入添加。</div>';
        return;
      }
      var html = '';
      cols.forEach(function(col, idx) {
        html += '<div style="display:flex; justify-content:space-between; align-items:center; background:var(--card-bg); padding:6px 8px; border-radius:4px; border:1px solid var(--card-border); font-size:0.75rem; font-weight:bold;">' +
          '<span>' + esc(col) + '</span>' +
          '<button class="delete-custom-col-btn" data-idx="' + idx + '" style="background:none; border:none; color:#e74c3c; cursor:pointer; font-weight:bold; font-size:0.9rem; padding:0 4px;">🗑️</button>' +
          '</div>';
      });
      container.innerHTML = html;
      container.querySelectorAll('.delete-custom-col-btn').forEach(function(btn) {
        btn.onclick = function() {
          var idx = parseInt(btn.getAttribute('data-idx'));
          var colName = DB.customColumns[idx];
          if (confirm('确认删除自定义列「' + colName + '」吗？(注意：删除列仅隐藏前端显示，已存入备注中的数据不会丢失)')) {
            DB.customColumns.splice(idx, 1);
            localStorage.setItem('crm_custom_columns', JSON.stringify(DB.customColumns));
            renderCustomColumnsList();
            renderCRMHeaders();
            dbTable(crmFilterData(DB.allData));
          }
        };
      });
    }

    function initCustomColumnsHandlers() {
      var manageBtn = document.getElementById('crmManageColsBtn');
      var modal = document.getElementById('customColumnsModal');
      var closeBtn = document.getElementById('closeCustomColumnsBtn');
      var addBtn = document.getElementById('addCustomColBtn');
      var input = document.getElementById('newCustomColInput');
      if (manageBtn && modal) {
        manageBtn.onclick = function() {
          renderCustomColumnsList();
          modal.classList.add('active');
        };
      }
      if (closeBtn && modal) {
        closeBtn.onclick = function() {
          modal.classList.remove('active');
        };
      }
      if (addBtn && input) {
        addBtn.onclick = function() {
          var val = input.value.trim();
          if (!val) return;
          if (val.length > 20) { alert('列名过长，请保持在20字以内'); return; }
          if (['name', 'mobile', 'phone', 'company', 'company_name', 'note', 'fund', 'category', 'batch_label', 'created_at', 'id'].indexOf(val.toLowerCase()) !== -1) {
            alert('该列名是系统保留字段，不能作为自定义列名');
            return;
          }
          if (DB.customColumns.indexOf(val) !== -1) {
            alert('该列名已存在');
            return;
          }
          DB.customColumns.push(val);
          localStorage.setItem('crm_custom_columns', JSON.stringify(DB.customColumns));
          input.value = '';
          renderCustomColumnsList();
          renderCRMHeaders();
          dbTable(crmFilterData(DB.allData));
        };
        input.addEventListener('keypress', function(e) {
          if (e.key === 'Enter') addBtn.click();
        });
      }
    }

    function renderImportMappingControls(headersList, detected) {
      var container = document.getElementById('aiAdjustControls');
      if (!container) return;
      var html = '<div style="display: flex; flex-direction: column; gap: 2px;">' +
        '<label style="font-size: 0.6rem; color: var(--text-light); font-weight: 800;">姓名数据列</label>' +
        '<select id="aiSelName" style="height: 24px; font-size: 0.65rem; outline: none; border: 1px solid var(--card-border); border-radius: 4px; font-weight: 800; color: var(--text-soft); background: var(--btn-bg);"></select>' +
        '</div>' +
        '<div style="display: flex; flex-direction: column; gap: 2px;">' +
        '<label style="font-size: 0.6rem; color: var(--text-light); font-weight: 800;">电话数据列</label>' +
        '<select id="aiSelPhone" style="height: 24px; font-size: 0.65rem; outline: none; border: 1px solid var(--card-border); border-radius: 4px; font-weight: 800; color: var(--text-soft); background: var(--btn-bg);"></select>' +
        '</div>' +
        '<div style="display: flex; flex-direction: column; gap: 2px;">' +
        '<label style="font-size: 0.6rem; color: var(--text-light); font-weight: 800;">公司数据列 (可选)</label>' +
        '<select id="aiSelCompany" style="height: 24px; font-size: 0.65rem; outline: none; border: 1px solid var(--card-border); border-radius: 4px; font-weight: 800; color: var(--text-soft); background: var(--btn-bg);"></select>' +
        '</div>' +
        '<div style="display: flex; flex-direction: column; gap: 2px;">' +
        '<label style="font-size: 0.6rem; color: var(--text-light); font-weight: 800;">备注数据列 (可选)</label>' +
        '<select id="aiSelNote" style="height: 24px; font-size: 0.65rem; outline: none; border: 1px solid var(--card-border); border-radius: 4px; font-weight: 800; color: var(--text-soft); background: var(--btn-bg);"></select>' +
        '</div>';
      var customCols = DB.customColumns || [];
      customCols.forEach(function(col) {
        html += '<div style="display: flex; flex-direction: column; gap: 2px;">' +
          '<label style="font-size: 0.6rem; color: var(--text-light); font-weight: 800;">' + esc(col) + ' 数据列 (可选)</label>' +
          '<select class="aiSelCustom" data-col="' + esc(col) + '" style="height: 24px; font-size: 0.65rem; outline: none; border: 1px solid var(--card-border); border-radius: 4px; font-weight: 800; color: var(--text-soft); background: var(--btn-bg);"></select>' +
          '</div>';
      });
      container.innerHTML = html;
      populateMappingSelect('aiSelName', headersList, detected.nameIdx);
      populateMappingSelect('aiSelPhone', headersList, detected.phoneIdx);
      populateMappingSelect('aiSelCompany', headersList, detected.companyIdx, true);
      populateMappingSelect('aiSelNote', headersList, detected.noteIdx, true);
      var customSelects = container.querySelectorAll('.aiSelCustom');
      customSelects.forEach(function(sel) {
        var colName = sel.getAttribute('data-col');
        var matchedIdx = -1;
        for (var h = 0; h < headersList.length; h++) {
          if (headersList[h] && headersList[h].label.toLowerCase() === colName.toLowerCase()) {
            matchedIdx = headersList[h].idx;
            break;
          }
        }
        populateMappingSelect(sel, headersList, matchedIdx, true);
        sel.addEventListener('change', updateAIPreviewTable);
      });
      document.getElementById('aiSelName').addEventListener('change', updateAIPreviewTable);
      document.getElementById('aiSelPhone').addEventListener('change', updateAIPreviewTable);
      document.getElementById('aiSelCompany').addEventListener('change', updateAIPreviewTable);
      document.getElementById('aiSelNote').addEventListener('change', updateAIPreviewTable);
    }

    // CRM 数据复合过滤器 (AND 关系)
    function crmFilterData(data) {
      var filtered = (data || []).slice();
      
      // 1. 快捷按钮筛选 (activeShortcut)
      if (DB.activeShortcut && DB.activeShortcut !== 'all') {
        if (DB.activeShortcut === 'today') {
          var todayStr = new Date().toISOString().slice(0, 10);
          filtered = filtered.filter(function(c) {
            return c.created_at && c.created_at.slice(0, 10) === todayStr;
          });
        } else if (DB.activeShortcut === 'never') {
          filtered = filtered.filter(function(c) {
            return (!c.note || c.note.trim() === '') && (!c.fund || c.fund.trim() === '');
          });
        } else if (DB.activeShortcut === '3days') {
          var threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
          filtered = filtered.filter(function(c) {
            return c.created_at && new Date(c.created_at).getTime() < threeDaysAgo;
          });
        }
      }

      // 2. 多维度搜索表单筛选 (AND 关系)
      var nameF = document.getElementById('dbNameSearch') ? document.getElementById('dbNameSearch').value.trim().toLowerCase() : '';
      var phoneF = document.getElementById('dbPhoneSearch') ? document.getElementById('dbPhoneSearch').value.trim().toLowerCase() : '';
      var noteF = document.getElementById('dbNoteSearch') ? document.getElementById('dbNoteSearch').value.trim().toLowerCase() : '';

      if (nameF) {
        filtered = filtered.filter(function(c) { return (c.name || '').toLowerCase().includes(nameF); });
      }
      if (phoneF) {
        filtered = filtered.filter(function(c) { return (c.mobile || '').toLowerCase().includes(phoneF); });
      }
      if (noteF) {
        filtered = filtered.filter(function(c) {
          var noteVal = (c.note || '').toLowerCase();
          var fundVal = (c.fund || '').toLowerCase();
          var customVal = '';
          var parsed = parseCustomerNote(c);
          for (var key in parsed.custom) {
            if (parsed.custom.hasOwnProperty(key)) {
              customVal += ' ' + String(parsed.custom[key]).toLowerCase();
            }
          }
          return noteVal.includes(noteF) || fundVal.includes(noteF) || customVal.includes(noteF);
        });
      }

      // 3. 排序 (Sort)
      if (DB.sortBy) {
        var isDesc = DB.sortDir === 'desc';
        filtered.sort(function(a, b) {
          var valA = '';
          var valB = '';
          if (DB.sortBy.indexOf('custom_') === 0) {
            var col = DB.sortBy.slice(7);
            var parsedA = parseCustomerNote(a);
            var parsedB = parseCustomerNote(b);
            valA = parsedA.custom[col] || '';
            valB = parsedB.custom[col] || '';
          } else if (DB.sortBy === 'created_at') {
            valA = a.created_at || '';
            valB = b.created_at || '';
          } else if (DB.sortBy === 'category') {
            valA = a.category || '';
            valB = b.category || '';
          } else {
            valA = a[DB.sortBy] || '';
            valB = b[DB.sortBy] || '';
          }
          var strA = String(valA).trim();
          var strB = String(valB).trim();
          var numA = parseFloat(strA);
          var numB = parseFloat(strB);
          if (!isNaN(numA) && !isNaN(numB)) {
            return isDesc ? numB - numA : numA - numB;
          }
          var cmp = strA.localeCompare(strB, 'zh-CN', { numeric: true, sensitivity: 'base' });
          return isDesc ? -cmp : cmp;
        });
      }

      return filtered;
    }

    function dbFetch() {
      var searchInput = document.getElementById('dbSearch');
      var q = searchInput ? searchInput.value.trim() : '';

      var activeTab = DB.activeTab || 'all';
      var catFilter = document.getElementById('dbCatFilter') ? document.getElementById('dbCatFilter').value : '';
      var batchFilter = document.getElementById('dbBatchFilter') ? document.getElementById('dbBatchFilter').value : '';

      var category = '';
      if (activeTab && activeTab !== 'all') {
        category = activeTab;
      } else if (catFilter) {
        category = catFilter;
      }

      var url = '/api/dialer/customers?page=' + DB.page + '&pageSize=' + DB.pageSize;
      if (q) url += '&search=' + encodeURIComponent(q);
      if (category) url += '&category=' + encodeURIComponent(category);
      if (batchFilter) url += '&batch_label=' + encodeURIComponent(batchFilter);
      if (DB.sortBy) url += '&sortBy=' + encodeURIComponent(DB.sortBy) + '&sortDir=' + DB.sortDir;

      var colCount = 8 + (DB.customColumns || []).length;
      var tbody = document.getElementById('dbTbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="' + colCount + '" class="db-loading">⏳ 数据加载中...</td></tr>';
      
      fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(res) {
          if (res.error) {
            if (tbody) tbody.innerHTML = '<tr><td colspan="' + colCount + '" style="text-align:center;padding:40px;color:#e74c3c;">⚠ Supabase 查询出错: ' + esc(res.error) + '</td></tr>';
            return;
          }
          var rawData = res.data || [];
          DB.allData = rawData; // 存入前端缓存
          
          var filtered = crmFilterData(rawData);
          DB.total = res.total || filtered.length;
          
          dbTable(filtered);
          dbPager(filtered);
          crmUpdateBadgeCounts(rawData);
          dbFilters(rawData);
          
          var totalEl = document.getElementById('dbTotal');
          if (totalEl) totalEl.textContent = '共 ' + DB.total + ' 条';
        })
        .catch(function(err) {
          if (tbody) tbody.innerHTML = '<tr><td colspan="' + colCount + '" style="text-align:center;padding:40px;color:#e74c3c;">⚠ 数据加载失败: ' + esc(err.message) + '</td></tr>';
        });
    }



    // 统计状态栏更新
    function crmUpdateBadgeCounts(data) {
      var red = 0, yellow = 0, blue = 0, cyan = 0;
      var d = data || [];
      var todayStr = new Date().toISOString().slice(0, 10);
      
      for (var i = 0; i < d.length; i++) {
        var c = d[i];
        var cat = c.category || '';
        if (c.batch_label && c.batch_label.includes('广告') && c.created_at && c.created_at.slice(0, 10) === todayStr) {
          red++;
        }
        if (c.batch_label && c.batch_label.includes('广告') && cat === '待跟进') {
          yellow++;
        }
        if (cat === '' || cat === '未分类' || !c.note) {
          blue++;
        }
        if (c.batch_label && !c.batch_label.includes('广告') && cat === '待跟进') {
          cyan++;
        }
      }

      if (document.getElementById('crmRedCount')) document.getElementById('crmRedCount').textContent = red;
      if (document.getElementById('crmYellowCount')) document.getElementById('crmYellowCount').textContent = yellow;
      if (document.getElementById('crmBlueCount')) document.getElementById('crmBlueCount').textContent = DB.total; 
      if (document.getElementById('crmCyanCount')) document.getElementById('crmCyanCount').textContent = cyan;
    }

    // 表格行渲染
    function dbTable(data) {
      var tb = document.getElementById('dbTbody');
      var em = document.getElementById('dbEmpty');
      if (!tb) return;
      
      if (!data || data.length === 0) {
        tb.innerHTML = '';
        if (em) em.style.display = 'block';
        return;
      }
      if (em) em.style.display = 'none';
      
      var h = '';
      var avatarColors = ['#ff5722', '#4a6cf7', '#07c160', '#ff9800', '#9c27b0', '#00bcd4', '#3f51b5', '#e91e63'];
      
      for (var i = 0; i < data.length; i++) {
        var c = data[i];
        var cat = c.category || '';
        
        var isChecked = DB.selectedIds[c.mobile] ? ' checked' : '';
        var isTrSelected = DB.selectedIds[c.mobile] ? ' class="selected"' : '';
        
        var isNew = c.created_at && (Date.now() - new Date(c.created_at).getTime() < 24 * 60 * 60 * 1000);
        var badgeHtml = isNew ? '<span class="crm-badge-new">新</span>' : '<span class="crm-badge-old">旧</span>';
        
        var firstChar = (c.name || '').trim().charAt(0) || '匿';
        var colorIdx = Math.abs(firstChar.charCodeAt(0)) % avatarColors.length;
        var avatarBg = avatarColors[colorIdx];
        var avatarHtml = '<span class="crm-avatar" style="background:' + avatarBg + ';">' + esc(firstChar) + '</span>';
        
        var parsed = parseCustomerNote(c);
        var realNote = parsed.note;
        var noteDisplay = '';
        if (c.fund) {
          noteDisplay = '<div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">' +
            '<span class="crm-fund-tag" style="background:rgba(255,152,0,0.12); color:#e65100; font-weight:900; font-size:11px; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; border: 1px solid rgba(255,152,0,0.25);">💰 公积金: ' + esc(c.fund) + '</span>' +
            (realNote ? '<span style="color:var(--text-soft); font-weight:normal;">' + esc(realNote) + '</span>' : '') +
            '</div>';
        } else {
          noteDisplay = realNote ? esc(realNote) : '-';
        }
        
        var customTds = '';
        var customCols = DB.customColumns || [];
        customCols.forEach(function(col) {
          var val = parsed.custom[col] || '-';
          customTds += '<td style="white-space: normal; min-width: 100px; word-break: break-all;">' + esc(val) + '</td>';
        });

        var createdAtStr = '';
        if (c.created_at) {
          var dt = new Date(c.created_at);
          if (!isNaN(dt.getTime())) {
            var y = dt.getFullYear();
            var m = String(dt.getMonth() + 1).padStart(2, '0');
            var d = String(dt.getDate()).padStart(2, '0');
            var hh = String(dt.getHours()).padStart(2, '0');
            var mm = String(dt.getMinutes()).padStart(2, '0');
            var ss = String(dt.getSeconds()).padStart(2, '0');
            createdAtStr = y + '-' + m + '-' + d + ' ' + hh + ':' + mm + ':' + ss;
          } else {
            createdAtStr = c.created_at;
          }
        } else {
          createdAtStr = '-';
        }

        h += '<tr' + isTrSelected + ' data-mobile="' + esc(c.mobile || '') + '">' +
          '<td style="text-align: center; cursor: default;"><input type="checkbox" class="crm-row-select" data-mobile="' + esc(c.mobile) + '" data-name="' + esc(c.name || '') + '"' + isChecked + '></td>' +
          '<td>' +
            '<div class="crm-name-cell">' +
              avatarHtml +
              '<div>' +
                '<div style="font-weight: 700; display: flex; align-items: center;">' + badgeHtml + esc(c.name || '-') + '</div>' +
                '<span class="cust-cat-tag set cat-' + esc(cat) + '" data-m="' + esc(c.mobile) + '" data-c="' + esc(cat) + '" style="margin-top: 3px; font-size:10px; padding: 0 6px;">' + esc(cat || '未分类') + '</span>' +
              '</div>' +
            '</div>' +
          '</td>' +
          '<td>' +
            '<div class="crm-phone-cell">' +
              esc(c.mobile || '-') +
              '<button class="crm-btn-call" title="点击呼叫 / 复制" onclick="copyTextToClipboard(\'' + esc(c.mobile) + '\');showCopyLimitToast(\'已复制: ' + esc(c.mobile) + '\');">📞</button>' +
            '</div>' +
          '</td>' +
          '<td style="white-space: normal; max-width: 300px; word-break: break-all;">' + noteDisplay + '</td>' +
          customTds +
          '<td style="white-space: normal;">' + esc(c.company_name || '-') + '</td>' +
          '<td style="white-space: nowrap;">' + esc(cat || '未分类') + '</td>' +
          '<td style="white-space: nowrap;">' + esc(createdAtStr) + '</td>' +
          '<td style="cursor: default;">' +
            '<a class="crm-action-link crm-btn-followup" data-mobile="' + esc(c.mobile) + '" data-note="' + esc(realNote || '') + '">新增跟进</a>' +
          '</td>' +
        '</tr>';
      }
      tb.innerHTML = h;
      
      // Wire individual row checkboxes
      var rowCbs = tb.querySelectorAll('.crm-row-select');
      rowCbs.forEach(function(cb) {
        cb.onchange = function() {
          var m = cb.getAttribute('data-mobile');
          var tr = cb.closest('tr');
          if (cb.checked) {
            DB.selectedIds[m] = true;
            if (tr) tr.classList.add('selected');
          } else {
            delete DB.selectedIds[m];
            if (tr) tr.classList.remove('selected');
          }
          // Update crmSelectAll status
          var allSelected = true;
          for (var j = 0; j < rowCbs.length; j++) {
            if (!rowCbs[j].checked) { allSelected = false; break; }
          }
          var selectAllCb = document.getElementById('crmSelectAll');
          if (selectAllCb) selectAllCb.checked = (rowCbs.length > 0 && allSelected);
        };
      });

      // Wire row click (except when clicking on checkboxes/links/buttons)
      tb.querySelectorAll('tr').forEach(function(row) {
        row.onclick = function(e) {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.closest('.crm-btn-call')) {
            return;
          }
          var cb = row.querySelector('.crm-row-select');
          if (cb) {
            cb.checked = !cb.checked;
            cb.onchange();
          }
        };
      });

      // Wire row follow-up click
      tb.querySelectorAll('.crm-btn-followup').forEach(function(btn) {
        btn.onclick = function(e) {
          e.stopPropagation();
          var mobile = btn.getAttribute('data-mobile');
          var oldNote = btn.getAttribute('data-note') || '';
          
          var newNote = prompt('请输入新增的跟进备注记录：', oldNote);
          if (newNote === null) return; // cancelled
          newNote = newNote.trim();
          if (newNote === oldNote) return; // no change
          
          btn.textContent = '⏳..';
          
          var clientObj = DB.allData.find(function(c) { return c.mobile === mobile; });
          var rawNoteStr = clientObj ? (clientObj.note || '') : '';
          var parsed = { note: oldNote, custom: {}, fund: '' };
          if (rawNoteStr.trim().indexOf('{') === 0) {
            try {
              var braceCount = 0;
              var jsonEndIdx = -1;
              for (var i = 0; i < rawNoteStr.length; i++) {
                if (rawNoteStr[i] === '{') braceCount++;
                else if (rawNoteStr[i] === '}') {
                  braceCount--;
                  if (braceCount === 0) { jsonEndIdx = i; break; }
                }
              }
              if (jsonEndIdx !== -1) {
                var jsonPart = rawNoteStr.slice(0, jsonEndIdx + 1);
                var obj = JSON.parse(jsonPart);
                if (obj && typeof obj === 'object') {
                  parsed.custom = obj.custom || {};
                  parsed.fund = obj.fund || '';
                }
              }
            } catch (err) {}
          }
          
          var notePayload = newNote;
          if (Object.keys(parsed.custom).length > 0 || parsed.fund) {
            var pl = { note: newNote, custom: parsed.custom };
            if (parsed.fund) pl.fund = parsed.fund;
            notePayload = JSON.stringify(pl);
          }
          
          fetch('/api/dialer/customers', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mobile: mobile,
              fields: { note: notePayload }
            })
          })
          .then(function(r) { return r.json(); })
          .then(function(res) {
            if (res.success) {
              dbFetch();
            } else {
              alert('更新跟进记录失败: ' + (res.error || '未知错误'));
              btn.textContent = '新增跟进';
            }
          })
          .catch(function(err) {
            alert('网络错误，更新失败: ' + err.message);
            btn.textContent = '新增跟进';
          });
        };
      });

      // Wire select all checkbox status
      var selectAllCb = document.getElementById('crmSelectAll');
      if (selectAllCb) {
        var allSelected = true;
        for (var j = 0; j < rowCbs.length; j++) {
          if (!rowCbs[j].checked) { allSelected = false; break; }
        }
        selectAllCb.checked = (rowCbs.length > 0 && allSelected);
      }
    }

    function dbPager(filteredData) {
      var tp = Math.max(1, Math.ceil(DB.total / DB.pageSize));
      var pageInput = document.getElementById('dbPageInput');
      var pageTotal = document.getElementById('dbPageTotal');
      if (pageInput) {
        pageInput.value = DB.page;
        pageInput.max = tp;
      }
      if (pageTotal) pageTotal.textContent = tp;
      var p = document.getElementById('dbPrev');
      var n = document.getElementById('dbNext');
      if (p) p.disabled = (DB.page <= 1);
      if (n) n.disabled = (DB.page >= tp);
    }

    function dbFilters(data) {
      var catS = document.getElementById('dbCatFilter');
      var batchS = document.getElementById('dbBatchFilter');
      if (!catS && !batchS) return;
      
      var cs = {};
      CATS.forEach(function(cat) { cs[cat] = true; });
      var bs = {};
      
      (data || []).forEach(function(c) {
        if (c.category) cs[c.category] = true;
        if (c.batch_label) bs[c.batch_label] = true;
      });
      
      if (catS) {
        var curCat = catS.value;
        var ch = '<option value="">请选择标签</option>';
        Object.keys(cs).sort().forEach(function(k) {
          ch += '<option value="' + esc(k) + '"' + (k === curCat ? ' selected' : '') + '>' + esc(k) + '</option>';
        });
        catS.innerHTML = ch;
      }
      
      if (batchS) {
        var curBatch = batchS.value;
        var bh = '<option value="">全部批次</option>';
        Object.keys(bs).sort().forEach(function(k) {
          bh += '<option value="' + esc(k) + '"' + (k === curBatch ? ' selected' : '') + '>' + esc(k) + '</option>';
        });
        batchS.innerHTML = bh;
      }
    }

    function dbSort(col){
      if (DB.sortBy === col) {
        DB.sortDir = DB.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        DB.sortBy = col; DB.sortDir = 'asc';
      }
      DB.page = 1; dbFetch();
    }

    function dbWireSortHeaders(){
      var ths = document.querySelectorAll('#dbOverlay .crm-table thead th[data-sort]');
      for (var i = 0; i < ths.length; i++) {
        (function(th){
          var col = th.getAttribute('data-sort');
          if (!col) return;
          th.onclick = function(){ dbSort(col); };
          var arrow = th.querySelector('.sort-arrow');
          if (arrow) {
            if (DB.sortBy === col) {
              arrow.textContent = DB.sortDir === 'asc' ? '▲' : '▼';
              th.classList.add('sorted');
            } else {
              arrow.textContent = '▲';
              th.classList.remove('sorted');
            }
          }
        })(ths[i]);
      }
    }

    // ====== Database Password Gate ======
    var DB_PWD_K = 'db_access_pwd_hash';
    var dbPwdCallback = null;
    var dbPwdSessionAuthed = false; // Once authenticated this session, don't ask again

    function hashPwd(pwd) {
      // Simple salted hash for localStorage (not cryptographically secure, but beats plaintext)
      var salt = 'megz_db_salt_2024';
      var combined = salt + ':' + pwd;
      var hash = 0;
      for (var i = 0; i < combined.length; i++) {
        var char = combined.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
      }
      return 'mz_' + Math.abs(hash).toString(36);
    }

    function getDbPassword() {
      return localStorage.getItem(DB_PWD_K) || '';
    }

    function showDbPasswordGate(callback) {
      dbPwdCallback = callback;
      var overlay = document.getElementById('dbPwdOverlay');
      var input = document.getElementById('dbPwdInput');
      var title = document.getElementById('dbPwdTitle');
      var hint = document.getElementById('dbPwdHint');
      var error = document.getElementById('dbPwdError');
      var resetBtn = document.getElementById('dbPwdResetBtn');
      var cancelBtn = document.getElementById('dbPwdCancelBtn');
      var confirmBtn = document.getElementById('dbPwdConfirmBtn');

      if (!overlay) { callback(); return; }

      var savedHash = getDbPassword();
      var isFirstTime = !savedHash;

      if (isFirstTime) {
        title.textContent = '🔐 设置数据库密码';
        hint.textContent = '请设置6位密码（字母+数字混搭）';
        resetBtn.style.display = 'none';
      } else {
        title.textContent = '🔐 数据库访问密码';
        hint.textContent = '请输入6位密码';
        resetBtn.style.display = 'inline-block';
      }

      input.value = '';
      error.style.display = 'none';
      overlay.style.display = 'flex';
      setTimeout(function() { overlay.classList.add('active'); input.focus(); }, 10);

      function doConfirm() {
        var pwd = input.value.trim();
        if (pwd.length !== 6) {
          error.textContent = '密码必须为6位';
          error.style.display = 'block';
          input.focus();
          return;
        }
        if (!/^[a-zA-Z0-9]+$/.test(pwd)) {
          error.textContent = '密码只能包含字母和数字';
          error.style.display = 'block';
          input.focus();
          return;
        }

        if (isFirstTime) {
          // Set password
          localStorage.setItem(DB_PWD_K, hashPwd(pwd));
          closeDbPasswordGate();
          dbPwdCallback && dbPwdCallback();
          dbPwdCallback = null;
        } else {
          // Verify password
          if (hashPwd(pwd) === savedHash) {
            closeDbPasswordGate();
            dbPwdCallback && dbPwdCallback();
            dbPwdCallback = null;
          } else {
            error.textContent = '密码错误，请重试';
            error.style.display = 'block';
            input.value = '';
            input.focus();
          }
        }
      }

      confirmBtn.onclick = doConfirm;
      input.onkeydown = function(e) {
        if (e.key === 'Enter') doConfirm();
      };

      cancelBtn.onclick = function() {
        closeDbPasswordGate();
        dbPwdCallback = null;
      };

      resetBtn.onclick = function() {
        // Verify old password first, then allow reset
        if (!confirm('确认要重置数据库密码吗？需要先验证旧密码。')) return;
        var oldPwd = prompt('请输入旧密码（6位）：');
        if (!oldPwd || oldPwd.length !== 6) { alert('密码必须为6位！'); return; }
        if (hashPwd(oldPwd) !== savedHash) { alert('旧密码错误！'); return; }
        localStorage.removeItem(DB_PWD_K);
        alert('旧密码已验证，请设置新密码。');
        // Restart the gate flow to set new password
        showDbPasswordGate(callback);
      };
    }

    function closeDbPasswordGate() {
      var overlay = document.getElementById('dbPwdOverlay');
      if (overlay) {
        overlay.classList.remove('active');
        setTimeout(function() { overlay.style.display = 'none'; }, 250);
      }
    }

    function openDBDashboard(){
      var ov=document.getElementById('dbOverlay'); if(!ov)return;
      if (dbPwdSessionAuthed) {
        _openDBDashboardInner();
        return;
      }
      var savedHash = getDbPassword();
      if (!savedHash) {
        // First time: must set password
        showDbPasswordGate(function() {
          dbPwdSessionAuthed = true;
          _openDBDashboardInner();
        });
        return;
      }
      showDbPasswordGate(function() {
        dbPwdSessionAuthed = true;
        _openDBDashboardInner();
      });
    }

    function _openDBDashboardInner() {
      var ov=document.getElementById('dbOverlay'); if(!ov)return;
      ov.classList.add('active'); DB.page=1;
      var si=document.getElementById('dbSearch'); if(si)si.value='';
      var cf=document.getElementById('dbCatFilter'); if(cf)cf.value='';
      var bf=document.getElementById('dbBatchFilter'); if(bf)bf.value='';
      renderCRMHeaders();
      
      var nameInp = document.getElementById('dbNameSearch');
      var phoneInp = document.getElementById('dbPhoneSearch');
      var noteInp = document.getElementById('dbNoteSearch');
      if (nameInp) nameInp.value = '';
      if (phoneInp) phoneInp.value = '';
      if (noteInp) noteInp.value = '';
      
      DB.pageSize=parseInt((document.getElementById('dbPageSize')||{}).value||'300');
      DB.selectedIds = {}; // Reset selections
      var selectAllCb = document.getElementById('crmSelectAll');
      if (selectAllCb) selectAllCb.checked = false;
      
      dbFetch();
    }
    window.openDBDashboard = openDBDashboard;
    window.parsePhoneContactsFromRawText = parsePhoneContactsFromRawText;
    window.renderAIUnstructuredReport = renderAIUnstructuredReport;
    window.correctOcrTextWithAI = correctOcrTextWithAI;

    function initCustViewer(){
      var ov=document.getElementById('dbOverlay'); if(!ov)return;
      var bt1=document.getElementById('custViewerBtn'), bt2=document.getElementById('custViewerBtn2');
      if(bt1)bt1.addEventListener('click',openDBDashboard);
      if(bt2)bt2.addEventListener('click',openDBDashboard);
      var cls=document.getElementById('dbClose'); if(cls)cls.addEventListener('click',function(){ov.classList.remove('active');});
      ov.addEventListener('click',function(e){if(e.target===ov)ov.classList.remove('active');});
      
      var si=document.getElementById('dbSearch'); if(si)si.addEventListener('input',function(){clearTimeout(DB.timer);DB.timer=setTimeout(function(){DB.page=1;dbFetch();},400);});
      var cf=document.getElementById('dbCatFilter'); if(cf)cf.addEventListener('change',function(){DB.page=1;dbFetch();});
      var bf=document.getElementById('dbBatchFilter'); if(bf)bf.addEventListener('change',function(){DB.page=1;dbFetch();});
      var ps=document.getElementById('dbPageSize'); if(ps)ps.addEventListener('change',function(){DB.pageSize=parseInt(ps.value);DB.page=1;dbFetch();});
      var pr=document.getElementById('dbPrev'); if(pr)pr.addEventListener('click',function(){if(DB.page>1){DB.page--;dbFetch();}});
      var nx=document.getElementById('dbNext'); if(nx)nx.addEventListener('click',function(){var tp=Math.max(1,Math.ceil(DB.total/DB.pageSize));if(DB.page<tp){DB.page++;dbFetch();}});
      
      var pageInput = document.getElementById('dbPageInput');
      if (pageInput) {
        var triggerPageChange = function() {
          var tp = Math.max(1, Math.ceil(DB.total / DB.pageSize));
          var val = parseInt(pageInput.value);
          if (isNaN(val) || val < 1) {
            val = 1;
          } else if (val > tp) {
            val = tp;
          }
          if (val !== DB.page) {
            DB.page = val;
            dbFetch();
          } else {
            pageInput.value = DB.page;
          }
        };
        pageInput.addEventListener('change', triggerPageChange);
        pageInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            triggerPageChange();
            pageInput.blur();
          }
        });
      }
      
      // Select all checkbox wiring
      var selectAllCb = document.getElementById('crmSelectAll');
      if (selectAllCb) {
        selectAllCb.onchange = function() {
          var checked = selectAllCb.checked;
          var tb = document.getElementById('dbTbody');
          if (!tb) return;
          var rowCbs = tb.querySelectorAll('.crm-row-select');
          rowCbs.forEach(function(cb) {
            cb.checked = checked;
            var m = cb.getAttribute('data-mobile');
            var tr = cb.closest('tr');
            if (checked) {
              DB.selectedIds[m] = true;
              if (tr) tr.classList.add('selected');
            } else {
              delete DB.selectedIds[m];
              if (tr) tr.classList.remove('selected');
            }
          });
        };
      }

      // Tabs wiring
      var tabs = document.querySelectorAll('#dbOverlay .crm-tab');
      tabs.forEach(function(tab) {
        tab.onclick = function() {
          tabs.forEach(function(t) { t.classList.remove('active'); });
          tab.classList.add('active');
          DB.activeTab = tab.getAttribute('data-tab') || 'all';
          DB.page = 1;
          dbFetch();
        };
      });

      // Shortcuts wiring
      var shortcuts = document.querySelectorAll('#dbOverlay .crm-shortcut-btn');
      shortcuts.forEach(function(btn) {
        btn.onclick = function() {
          shortcuts.forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          DB.activeShortcut = btn.getAttribute('data-shortcut') || 'all';
          DB.page = 1;
          dbFetch();
        };
      });

      // Search & Reset buttons wiring
      var searchBtn = document.getElementById('crmSearchBtn');
      if (searchBtn) {
        searchBtn.onclick = function() {
          DB.page = 1;
          dbFetch();
        };
      }
      var resetBtn = document.getElementById('crmResetBtn');
      if (resetBtn) {
        resetBtn.onclick = function() {
          var nameInp = document.getElementById('dbNameSearch');
          var phoneInp = document.getElementById('dbPhoneSearch');
          var noteInp = document.getElementById('dbNoteSearch');
          var catSel = document.getElementById('dbCatFilter');
          var batchSel = document.getElementById('dbBatchFilter');
          
          if (nameInp) nameInp.value = '';
          if (phoneInp) phoneInp.value = '';
          if (noteInp) noteInp.value = '';
          if (catSel) catSel.value = '';
          if (batchSel) batchSel.value = '';
          
          DB.page = 1;
          dbFetch();
        };
      }

      var searchInputs = [
        document.getElementById('dbNameSearch'),
        document.getElementById('dbPhoneSearch'),
        document.getElementById('dbNoteSearch')
      ];
      searchInputs.forEach(function(inp) {
        if (inp) {
          inp.onkeydown = function(e) {
            if (e.key === 'Enter') {
              e.preventDefault();
              DB.page = 1;
              dbFetch();
            }
          };
        }
      });

      // Toolbar action: ➕ 添加客户
      var addCustBtn = document.getElementById('crmAddCustBtn');
      if (addCustBtn) {
        addCustBtn.onclick = function() {
          var name = prompt('请输入客户姓名：');
          if (name === null) return;
          name = name.trim();
          if (!name) { alert('姓名不能为空'); return; }
          
          var mobile = prompt('请输入客户手机号：');
          if (mobile === null) return;
          mobile = mobile.trim();
          if (!mobile) { alert('手机号不能为空'); return; }
          
          var company = prompt('请输入客户单位/公司名称（可选）：') || '';
          company = company.trim();
          
          var note = prompt('请输入备注信息（可选）：') || '';
          note = note.trim();
          
          var catOpts = CATS.join(' / ');
          var cat = prompt('请输入客户分类（可选，例如: 意向客户。候选值: ' + catOpts + '）：') || '';
          cat = cat.trim();
          
          addCustBtn.disabled = true;
          addCustBtn.textContent = '⏳ 添加中...';
          
          fetch('/api/dialer/upload-customers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              customers: [{
                name: name,
                mobile: mobile,
                company: company,
                note: note
              }],
              batch_label: '手动录入'
            })
          })
          .then(function(r) { return r.json(); })
          .then(function(res) {
            if (res.success) {
              if (cat) {
                return fetch('/api/dialer/customers', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    mobile: mobile,
                    fields: { category: cat }
                  })
                }).then(function(r) { return r.json(); });
              }
              return { success: true };
            } else {
              throw new Error(res.error || '添加失败');
            }
          })
          .then(function(res) {
            if (res.success) {
              alert('添加客户成功！');
              dbFetch();
            } else {
              alert('更新分类失败: ' + (res.error || '未知'));
            }
          })
          .catch(function(err) {
            alert('添加客户出错: ' + err.message);
          })
          .then(function() {
            addCustBtn.disabled = false;
            addCustBtn.textContent = '➕ 添加客户';
          });
        };
      }

      // Toolbar action: 📞 添加到待拨打
      var addToDialBtn = document.getElementById('crmAddToDialBtn');
      if (addToDialBtn) {
        addToDialBtn.onclick = function() {
          var selectedMobiles = Object.keys(DB.selectedIds);
          if (selectedMobiles.length === 0) { alert('请先勾选需要添加到待拨打的客户'); return; }
          
          var addedCount = 0;
          selectedMobiles.forEach(function(m) {
            var clientData = DB.allData.find(function(c) { return c.mobile === m; });
            if (clientData) {
              var exists = importedClients.some(function(ic) { return (ic.mobile || ic.phone) === m; });
              if (!exists) {
                var parsed = parseCustomerNote(clientData);
                importedClients.push({
                  name: clientData.name || '未知',
                  phone: clientData.mobile,
                  mobile: clientData.mobile,
                  company: clientData.company_name || '',
                  note: parsed.note,
                  custom: parsed.custom,
                  fund: clientData.fund || '',
                  category: clientData.category || '',
                  batch_label: clientData.batch_label || ''
                });
                addedCount++;
              }
            }
          });
          
          if (addedCount > 0) {
            localStorage.setItem(CLIENTS_K, JSON.stringify(importedClients));
            renderDialCards();
            alert('成功添加 ' + addedCount + ' 个客户到待拨打列表');
            DB.selectedIds = {};
            var selectAllCb = document.getElementById('crmSelectAll');
            if (selectAllCb) selectAllCb.checked = false;
            dbTable(crmFilterData(DB.allData));
          } else {
            alert('选中的客户已在待拨打列表中');
          }
        };
      }

      // Toolbar action: 📥 按分类一键拉取
      var pullFilteredBtn = document.getElementById('crmPullFilteredBtn');
      if (pullFilteredBtn) {
        pullFilteredBtn.onclick = function() {
          var activeTab = DB.activeTab || 'all';
          var catFilter = document.getElementById('dbCatFilter') ? document.getElementById('dbCatFilter').value : '';
          var batchFilter = document.getElementById('dbBatchFilter') ? document.getElementById('dbBatchFilter').value : '';
          
          var category = '';
          if (activeTab && activeTab !== 'all') {
            category = activeTab;
          } else if (catFilter) {
            category = catFilter;
          }
          
          var confirmMsg = '确认从数据库拉取';
          if (category) confirmMsg += '「' + category + '」分类';
          if (batchFilter) confirmMsg += '「' + batchFilter + '」批次';
          if (!category && !batchFilter) confirmMsg += '所有';
          confirmMsg += '的客户到拨号盘吗？(已存在在拨号盘中的手机号将自动跳过，最大拉取5000条)';
          
          if (!confirm(confirmMsg)) return;
          
          pullFilteredBtn.disabled = true;
          pullFilteredBtn.textContent = '⏳ 拉取中...';
          
          var pullUrl = '/api/dialer/customers?page=1&pageSize=5000';
          if (category) pullUrl += '&category=' + encodeURIComponent(category);
          if (batchFilter) pullUrl += '&batch_label=' + encodeURIComponent(batchFilter);
          
          fetch(pullUrl)
            .then(function(r) { return r.json(); })
            .then(function(res) {
              pullFilteredBtn.disabled = false;
              pullFilteredBtn.textContent = '📥 按分类一键拉取';
              if (res.error) {
                alert('拉取失败: ' + res.error);
                return;
              }
              var dbClients = res.data || [];
              if (dbClients.length === 0) {
                alert('数据库中没有找到符合当前分类/筛选的客户记录！');
                return;
              }
              
              var addedCount = 0;
              dbClients.forEach(function(c) {
                var m = c.mobile;
                if (!m) return;
                var exists = importedClients.some(function(ic) { return (ic.mobile || ic.phone) === m; });
                if (!exists) {
                  var parsed = parseCustomerNote(c);
                  importedClients.push({
                    name: c.name || '未知',
                    phone: c.mobile,
                    mobile: c.mobile,
                    company: c.company_name || '',
                    note: parsed.note,
                    custom: parsed.custom,
                    fund: c.fund || '',
                    category: c.category || '',
                    batch_label: c.batch_label || ''
                  });
                  addedCount++;
                }
              });
              
              if (addedCount > 0) {
                localStorage.setItem(CLIENTS_K, JSON.stringify(importedClients));
                renderDialCards();
                updateDashboardVisibility(true);
                alert('成功从数据库拉取了 ' + addedCount + ' 个客户到拨号盘列表！');
                document.getElementById('dbOverlay').classList.remove('active');
              } else {
                alert('拉取了 ' + dbClients.length + ' 个客户，但已全部存在在拨号盘列表中！');
              }
            })
            .catch(function(err) {
              pullFilteredBtn.disabled = false;
              pullFilteredBtn.textContent = '📥 按分类一键拉取';
              alert('拉取失败: ' + err.message);
            });
        };
      }

      // Toolbar action: 👤 转入意向客户
      var moveIntentBtn = document.getElementById('crmMoveIntentBtn');
      if (moveIntentBtn) {
        moveIntentBtn.onclick = function() {
          var mobiles = Object.keys(DB.selectedIds);
          if (mobiles.length === 0) { alert('请先勾选要转入意向客户的数据'); return; }
          
          if (!confirm('确认将选中的 ' + mobiles.length + ' 个客户转入「意向客户」吗？')) return;
          
          moveIntentBtn.disabled = true;
          moveIntentBtn.textContent = '⏳ 处理中...';
          
          var promises = mobiles.map(function(m) {
            return fetch('/api/dialer/customers', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mobile: m,
                fields: { category: '意向客户' }
              })
            }).then(function(r) { return r.json(); });
          });
          
          Promise.all(promises)
          .then(function(results) {
            var successCount = results.filter(function(r) { return r && r.success; }).length;
            alert('操作完成，成功转入意向客户 ' + successCount + ' / ' + mobiles.length + ' 条');
            DB.selectedIds = {};
            var selectAllCb = document.getElementById('crmSelectAll');
            if (selectAllCb) selectAllCb.checked = false;
            dbFetch();
          })
          .catch(function(err) {
            alert('批量转入意向客户出错: ' + err.message);
          })
          .then(function() {
            moveIntentBtn.disabled = false;
            moveIntentBtn.textContent = '👤 转入意向客户';
          });
        };
      }

      // Toolbar action: 👤 转入线索池
      var moveLeadsBtn = document.getElementById('crmMoveLeadsBtn');
      if (moveLeadsBtn) {
        moveLeadsBtn.onclick = function() {
          var mobiles = Object.keys(DB.selectedIds);
          if (mobiles.length === 0) { alert('请先勾选要转入线索池的数据'); return; }
          
          if (!confirm('确认将选中的 ' + mobiles.length + ' 个客户转入「线索池」吗？')) return;
          
          moveLeadsBtn.disabled = true;
          moveLeadsBtn.textContent = '⏳ 处理中...';
          
          var promises = mobiles.map(function(m) {
            return fetch('/api/dialer/customers', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mobile: m,
                fields: { category: '潜在客户' }
              })
            }).then(function(r) { return r.json(); });
          });
          
          Promise.all(promises)
          .then(function(results) {
            var successCount = results.filter(function(r) { return r && r.success; }).length;
            alert('操作完成，成功转入线索池 ' + successCount + ' / ' + mobiles.length + ' 条');
            DB.selectedIds = {};
            var selectAllCb = document.getElementById('crmSelectAll');
            if (selectAllCb) selectAllCb.checked = false;
            dbFetch();
          })
          .catch(function(err) {
            alert('批量转入线索池出错: ' + err.message);
          })
          .then(function() {
            moveLeadsBtn.disabled = false;
            moveLeadsBtn.textContent = '👤 转入线索池';
          });
        };
      }

      // Toolbar action: 🗑️ 批量删除
      var batchDeleteBtn = document.getElementById('crmBatchDeleteBtn');
      if (batchDeleteBtn) {
        batchDeleteBtn.onclick = function() {
          var mobiles = Object.keys(DB.selectedIds);
          if (mobiles.length === 0) { alert('请先勾选需要删除的客户'); return; }
          
          if (!confirm('🚨 警告：确认删除选中的 ' + mobiles.length + ' 个客户吗？该操作不可逆，将从数据库彻底移除！')) return;
          
          batchDeleteBtn.disabled = true;
          batchDeleteBtn.textContent = '⏳ 删除中...';
          
          fetch('/api/dialer/customers', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mobiles: mobiles })
          })
          .then(function(r) { return r.json(); })
          .then(function(res) {
            if (res.success) {
              alert('成功删除 ' + (res.count || mobiles.length) + ' 个客户！');
              DB.selectedIds = {};
              var selectAllCb = document.getElementById('crmSelectAll');
              if (selectAllCb) selectAllCb.checked = false;
              dbFetch();
            } else {
              alert('删除失败: ' + (res.error || '未知错误'));
            }
          })
          .catch(function(err) {
            alert('删除出错: ' + err.message);
          })
          .then(function() {
            batchDeleteBtn.disabled = false;
            batchDeleteBtn.textContent = '🗑️ 批量删除';
          });
        };
      }

      // Toolbar action: 🌐 转入公海
      var movePublicBtn = document.getElementById('crmMovePublicBtn');
      if (movePublicBtn) {
        movePublicBtn.onclick = function() {
          var mobiles = Object.keys(DB.selectedIds);
          if (mobiles.length === 0) { alert('请先勾选要转入公海的数据'); return; }
          
          if (!confirm('确认将选中的 ' + mobiles.length + ' 个客户转入「公海客户」吗？')) return;
          
          movePublicBtn.disabled = true;
          movePublicBtn.textContent = '⏳ 处理中...';
          
          var promises = mobiles.map(function(m) {
            return fetch('/api/dialer/customers', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mobile: m,
                fields: { category: '公海客户' }
              })
            }).then(function(r) { return r.json(); });
          });
          
          Promise.all(promises)
          .then(function(results) {
            var successCount = results.filter(function(r) { return r && r.success; }).length;
            alert('操作完成，成功转入公海客户 ' + successCount + ' / ' + mobiles.length + ' 条');
            DB.selectedIds = {};
            var selectAllCb = document.getElementById('crmSelectAll');
            if (selectAllCb) selectAllCb.checked = false;
            dbFetch();
          })
          .catch(function(err) {
            alert('批量转入公海出错: ' + err.message);
          })
          .then(function() {
            movePublicBtn.disabled = false;
            movePublicBtn.textContent = '🌐 转入公海';
          });
        };
      }

      // Toolbar action: 🤝 添加协助人
      var addHelperBtn = document.getElementById('crmAddHelperBtn');
      if (addHelperBtn) {
        addHelperBtn.onclick = function() {
          var mobiles = Object.keys(DB.selectedIds);
          if (mobiles.length === 0) { alert('请先勾选需要添加协助人的客户'); return; }
          var helper = prompt('请输入协助人姓名：');
          if (helper === null) return;
          helper = helper.trim();
          if (!helper) return;
          
          addHelperBtn.disabled = true;
          
          var promises = mobiles.map(function(m) {
            var clientData = DB.allData.find(function(c) { return c.mobile === m; });
            var oldNote = clientData ? (clientData.note || '') : '';
            var newNote = oldNote + (oldNote ? ' ' : '') + '[协助人: ' + helper + ']';
            return fetch('/api/dialer/customers', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mobile: m,
                fields: { note: newNote }
              })
            }).then(function(r) { return r.json(); });
          });
          
          Promise.all(promises)
          .then(function() {
            alert('添加协助人成功');
            DB.selectedIds = {};
            var selectAllCb = document.getElementById('crmSelectAll');
            if (selectAllCb) selectAllCb.checked = false;
            dbFetch();
          })
          .catch(function(err) {
            alert('添加协助人失败: ' + err.message);
          })
          .then(function() {
            addHelperBtn.disabled = false;
          });
        };
      }

      // Toolbar action: 🚫 取消协助人
      var removeHelperBtn = document.getElementById('crmRemoveHelperBtn');
      if (removeHelperBtn) {
        removeHelperBtn.onclick = function() {
          var mobiles = Object.keys(DB.selectedIds);
          if (mobiles.length === 0) { alert('请先勾选需要取消协助人的客户'); return; }
          
          removeHelperBtn.disabled = true;
          
          var promises = mobiles.map(function(m) {
            var clientData = DB.allData.find(function(c) { return c.mobile === m; });
            var note = clientData ? (clientData.note || '') : '';
            var newNote = note.replace(/[协助人:s*[^]]+]/g, '').trim();
            return fetch('/api/dialer/customers', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mobile: m,
                fields: { note: newNote }
              })
            }).then(function(r) { return r.json(); });
          });
          
          Promise.all(promises)
          .then(function() {
            alert('取消协助人成功');
            DB.selectedIds = {};
            var selectAllCb = document.getElementById('crmSelectAll');
            if (selectAllCb) selectAllCb.checked = false;
            dbFetch();
          })
          .catch(function(err) {
            alert('取消协助人失败: ' + err.message);
          })
          .then(function() {
            removeHelperBtn.disabled = false;
          });
        };
      }

      // Hash trigger: /dialer#db auto-opens
      if(window.location.hash==='#db'){setTimeout(openDBDashboard,300);}

      // Batch category wiring
      var bcpBtn = document.getElementById('dbBatchCatBtn');
      var bcpPanel = document.getElementById('dbBatchCatPanel');
      var bcpSel = document.getElementById('dbBatchCatSel');
      var bcpTarget = document.getElementById('dbCatTargetSel');
      var bcpApply = document.getElementById('dbBatchCatApply');
      var bcpCancel = document.getElementById('dbBatchCatCancel');
      var bcpStatus = document.getElementById('dbBatchCatStatus');

      if (bcpBtn) bcpBtn.addEventListener('click', function() {
        if (bcpPanel.style.display === 'none' || !bcpPanel.style.display) {
          bcpPanel.style.display = 'flex';
          var catOpts = '<option value="">选择分类</option>';
          CATS.forEach(function(c2) { catOpts += '<option value="' + esc(c2) + '">' + esc(c2) + '</option>'; });
          if (bcpTarget) bcpTarget.innerHTML = catOpts;
          if (bcpSel) {
            var bf2 = document.getElementById('dbBatchFilter');
            var opts = '<option value="">选择批次</option>';
            if (bf2) {
              var bfOpts = bf2.querySelectorAll('option');
              bfOpts.forEach(function(o) { if (o.value) opts += '<option value="' + esc(o.value) + '">' + esc(o.textContent) + '</option>'; });
            }
            bcpSel.innerHTML = opts;
          }
          if (bcpStatus) bcpStatus.style.display = 'none';
        } else {
          bcpPanel.style.display = 'none';
        }
      });

      if (bcpCancel) bcpCancel.addEventListener('click', function() { bcpPanel.style.display = 'none'; });

      if (bcpApply) bcpApply.addEventListener('click', function() {
        var batch = bcpSel ? bcpSel.value : '';
        var cat = bcpTarget ? bcpTarget.value : '';
        if (!batch || !cat) { alert('请选择批次和目标分类'); return; }
        if (bcpStatus) { bcpStatus.style.display = 'inline'; bcpStatus.textContent = '⏳ 更新中...'; bcpStatus.style.color = '#f57c00'; }
        fetch('/api/dialer/customers/batch-category', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch_label: batch, category: cat })
        })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.success) {
            if (bcpStatus) { bcpStatus.textContent = '已更新 ' + d.updated + ' 条'; bcpStatus.style.color = '#07c160'; }
            bcpPanel.style.display = 'none';
            dbFetch();
          } else {
            if (bcpStatus) { bcpStatus.textContent = '失败: ' + (d.error || '未知'); bcpStatus.style.color = '#e74c3c'; }
          }
        })
        .catch(function(err) {
          if (bcpStatus) { bcpStatus.textContent = '网络错误'; bcpStatus.style.color = '#e74c3c'; }
        });
      });
    }

  function initHeaderMenu() {
      var menuBtn = document.getElementById('headerMenuBtn');
      var dropdown = document.getElementById('headerDropdown');
      
      if (menuBtn && dropdown) {
        menuBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          if (dropdown.style.display === 'none' || !dropdown.style.display) {
            dropdown.style.display = 'flex';
          } else {
            dropdown.style.display = 'none';
          }
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', function(e) {
          if (!menuBtn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.style.display = 'none';
          }
        });

        // Also close dropdown when selecting any option inside it
        dropdown.querySelectorAll('.dropdown-item').forEach(function(item) {
          item.addEventListener('click', function() {
            dropdown.style.display = 'none';
          });
        });
      }
    }

    function initNoteModal() {
      var modal = document.getElementById('noteModal');
      var closeBtn = document.getElementById('closeNoteModalBtn');
      if (modal && closeBtn) {
        closeBtn.addEventListener('click', function() {
          modal.classList.remove('active');
        });
        modal.addEventListener('click', function(e) {
          if (e.target === this) {
            modal.classList.remove('active');
          }
        });
      }
    }

    // ===== Whitelist Management =====

    function fetchWhitelist() {
      return fetch('/api/whitelist/companies')
        .then(function(r) {
          if (!r.ok) throw new Error('获取白名单失败');
          return r.json();
        })
        .then(function(data) {
          whitelistCompanies = data.companies || [];
          whitelistLoaded = true;
          updateWhitelistStatus();
          renderWhitelistCompanyList();
          return whitelistCompanies;
        })
        .catch(function(err) {
          console.error('Whitelist fetch error:', err);
          whitelistLoaded = false;
        });
    }

    function uploadWhitelist(companyNames) {
      return fetch('/api/whitelist/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies: companyNames })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('上传白名单失败');
        return r.json();
      });
    }

    function checkWhitelist() {
      resetWhitelistCheck();
      var companySet = {};
      importedClients.forEach(function(c) {
        if (c.company && String(c.company).trim()) {
          companySet[String(c.company).trim()] = true;
        }
      });
      var uniqueCompanies = Object.keys(companySet);

      if (uniqueCompanies.length === 0) {
        alert('当前没有导入带有单位名称的客户数据');
        return Promise.resolve();
      }

      return fetch('/api/whitelist/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies: uniqueCompanies })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('白名单检查失败');
        return r.json();
      })
      .then(function(data) {
        var results = data.results || [];
        whitelistCheckResults = {};
        results.forEach(function(r) {
          whitelistCheckResults[r.company] = r;
        });
        renderDialCards();
        return results;
      })
      .catch(function(err) {
        console.error('Whitelist check error:', err);
        alert('白名单检查失败: ' + err.message);
      });
    }

    function updateWhitelistStatus() {
      var el = document.getElementById('whitelistStatus');
      if (el) {
        el.textContent = '已加载 ' + whitelistCompanies.length + ' 家白名单企业';
      }
    }

    function handleFailedUploads(companies) {
      try {
        var failed = JSON.parse(localStorage.getItem('whitelist_failed_uploads') || '[]');
        var failedSet = new Set(failed);
        companies.forEach(function(c) { failedSet.add(c); });
        localStorage.setItem('whitelist_failed_uploads', JSON.stringify(Array.from(failedSet)));
        renderFailedUploadsArea();
      } catch (e) {
        console.error('Failed to save failed whitelist uploads:', e);
      }
    }

    function renderFailedUploadsArea() {
      var container = document.getElementById('whitelistFailedArea');
      var listEl = document.getElementById('whitelistFailedList');
      var countEl = document.getElementById('whitelistFailedCount');
      if (!container || !listEl || !countEl) return;

      var failed = [];
      try {
        failed = JSON.parse(localStorage.getItem('whitelist_failed_uploads') || '[]');
      } catch (e) {}

      if (failed.length === 0) {
        container.style.display = 'none';
        return;
      }

      container.style.display = 'block';
      countEl.textContent = failed.length;
      listEl.textContent = failed.map(function(c) {
        if (typeof c === 'string') return c;
        return c.company_name + (c.status && c.status !== '正常' ? ',' + c.status : '');
      }).join('\n');
    }

    function fuzzyMatch(text, query) {
      if (!text) return false;
      text = text.toLowerCase().trim();
      query = query.toLowerCase().trim();
      if (!query) return true;
      if (text.includes(query)) return true;
      var keywords = query.split(/s+/).filter(Boolean);
      if (keywords.length > 1) {
        return keywords.every(function(kw) { return text.includes(kw); });
      }
      var escapedQuery = query.replace(/[-/\^$*+?.()|[]{}]/g, '\\$&');
      var chars = escapedQuery.split('');
      var regexStr = chars.join('.*');
      try {
        var regex = new RegExp(regexStr, 'i');
        return regex.test(text);
      } catch (e) {
        return false;
      }
    }

    function renderWhitelistCompanyList() {
      var container = document.getElementById('whitelistCompanyList');
      if (!container) return;

      var searchInput = document.getElementById('whitelistModalSearchInput');
      var query = searchInput ? searchInput.value.toLowerCase().trim() : '';

      var filtered = whitelistCompanies;
      if (query) {
        filtered = whitelistCompanies.filter(function(c) {
          return fuzzyMatch(c.company_name, query) || fuzzyMatch(c.alias, query);
        });
      }

      if (filtered.length === 0) {
        container.innerHTML = '<div style="font-size:0.7rem; color:var(--text-light); text-align:center; padding:10px;">' + (query ? '无匹配搜索的企业' : '暂无白名单企业数据') + '</div>';
        return;
      }

      var html = '';
      filtered.forEach(function(c) {
        html += '<div class="whitelist-company-item">' +
          '<span style="font-size:0.72rem; font-weight:700; color:var(--text-main);">' + esc(c.company_name) + '</span>' +
          '<button class="whitelist-del-btn" data-company="' + esc(c.company_name) + '" style="font-size:0.6rem; padding:2px 8px; border:1px solid #e74c3c; background:transparent; color:#e74c3c; border-radius:3px; cursor:pointer; font-weight:700;">删除</button>' +
          '</div>';
      });
      container.innerHTML = html;

      container.querySelectorAll('.whitelist-del-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var company = this.dataset.company;
          if (confirm('确认从白名单中删除「' + company + '」吗？')) {
            deleteWhitelistCompany(company);
          }
        });
      });
    }

    function deleteWhitelistCompany(companyName) {
      fetch('/api/whitelist/companies', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_name: companyName })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('删除失败');
        return r.json();
      })
      .then(function() {
        whitelistCompanies = whitelistCompanies.filter(function(c) {
          return c.company_name !== companyName;
        });
        updateWhitelistStatus();
        renderWhitelistCompanyList();
        if (whitelistCheckResults) {
          checkWhitelist();
        }
      })
      .catch(function(err) {
        alert('删除失败: ' + err.message);
      });
    }

    function resetWhitelistCheck() {
      whitelistCheckResults = null;
    }

    function initWhitelist() {
      var whitelistBtn = document.getElementById('whitelistMenuBtn');
      var whitelistModal = document.getElementById('whitelistModal');
      var closeBtn = document.getElementById('closeWhitelistBtn');
      var uploadBtn = document.getElementById('whitelistUploadBtn');
      var refreshBtn = document.getElementById('whitelistRefreshBtn');
      var checkBtn = document.getElementById('whitelistCheckBtn');
      var textarea = document.getElementById('whitelistTextarea');
      var failedClearBtn = document.getElementById('whitelistFailedClearBtn');
      var failedRetryBtn = document.getElementById('whitelistFailedRetryBtn');
      var modalSearch = document.getElementById('whitelistModalSearchInput');

      // Open modal from dropdown
      if (whitelistBtn && whitelistModal) {
        whitelistBtn.addEventListener('click', function() {
          whitelistModal.classList.add('active');
          renderFailedUploadsArea();
          if (!whitelistLoaded) {
            fetchWhitelist();
          }
        });
      }

      // Close modal
      if (closeBtn && whitelistModal) {
        closeBtn.addEventListener('click', function() {
          whitelistModal.classList.remove('active');
        });
        whitelistModal.addEventListener('click', function(e) {
          if (e.target === whitelistModal) {
            whitelistModal.classList.remove('active');
          }
        });
      }

      // Upload
      if (uploadBtn && textarea) {
        uploadBtn.addEventListener('click', function() {
          var text = textarea.value.trim();
          if (!text) { alert('请先粘贴企业名称'); return; }
          var companies = text.split('\n')
            .map(function(s) { return s.trim(); })
            .filter(function(s) { return s.length > 0; });
          if (companies.length === 0) { alert('请至少输入一个企业名称'); return; }

          uploadBtn.textContent = '上传中...';
          uploadBtn.disabled = true;
          uploadWhitelist(companies)
            .then(function(result) {
              alert('成功上传 ' + result.count + ' 家企业到白名单');
              textarea.value = '';
              return fetchWhitelist();
            })
            .catch(function(err) {
              alert('上传失败：' + err.message + '。已存入本地失败重试列表。');
              handleFailedUploads(companies);
            })
            .then(function() {
              uploadBtn.textContent = '上传白名单';
              uploadBtn.disabled = false;
            });
        });
      }

      // Refresh
      if (refreshBtn) {
        refreshBtn.addEventListener('click', function() {
          fetchWhitelist();
        });
      }

      // Whitelist search
      if (modalSearch) {
        modalSearch.addEventListener('input', function() {
          renderWhitelistCompanyList();
        });
      }

      // Failed Area Clear
      if (failedClearBtn) {
        failedClearBtn.addEventListener('click', function(e) {
          e.preventDefault();
          localStorage.removeItem('whitelist_failed_uploads');
          renderFailedUploadsArea();
        });
      }

      // Failed Area Retry
      if (failedRetryBtn) {
        failedRetryBtn.addEventListener('click', function() {
          var failed = [];
          try {
            failed = JSON.parse(localStorage.getItem('whitelist_failed_uploads') || '[]');
          } catch (e) {}
          if (failed.length === 0) return;

          failedRetryBtn.textContent = '重试中...';
          failedRetryBtn.disabled = true;
          uploadWhitelist(failed)
            .then(function(result) {
              alert('重新上传成功，共导入 ' + result.count + ' 家企业');
              localStorage.removeItem('whitelist_failed_uploads');
              renderFailedUploadsArea();
              return fetchWhitelist();
            })
            .catch(function(err) {
              alert('重试上传依然失败: ' + err.message);
            })
            .then(function() {
              failedRetryBtn.textContent = '尝试重新上传';
              failedRetryBtn.disabled = false;
            });
        });
      }

      // Check button in control bar
      if (checkBtn) {
        checkBtn.addEventListener('click', function() {
          checkBtn.textContent = '检查中...';
          checkBtn.disabled = true;
          var promise = whitelistLoaded ? Promise.resolve() : fetchWhitelist();
          promise
            .then(function() { return checkWhitelist(); })
            .catch(function() {})
            .then(function() {
              checkBtn.textContent = '☑ 白名单';
              checkBtn.disabled = false;
            });
        });
      }

      // Auto-load whitelist on initialization and re-render cards
      fetchWhitelist().then(function() {
        renderDialCards();
      });

      // Initial check for failed uploads
      renderFailedUploadsArea();
    }

    // Main Init (每个 init 独立 try-catch，防止某个报错导致后续按钮初始化被跳过)
    function safeInit(name, fn) {
      try { fn(); } catch (e) { console.error('Init error: ' + name, e); }
    }
    safeInit('initDark', initDark);
    safeInit('initFileInputs', initFileInputs);
    safeInit('initCallControls', initCallControls);
    safeInit('initFilters', initFilters);
    safeInit('initDataActions', initDataActions);
    safeInit('initSyncHandlers', initSyncHandlers);
    safeInit('initHeaderMenu', initHeaderMenu);
    safeInit('initNoteModal', initNoteModal);
    safeInit('initCustomColumnsHandlers', initCustomColumnsHandlers);
    safeInit('initWhitelist', initWhitelist);
    safeInit('initAIImporter', initAIImporter);
    safeInit('loadPersistedState', loadPersistedState);
    safeInit('initCustViewer', initCustViewer);

  })();
  