// 生活记事录 - Cloudflare Worker 版本
// 部署后绑定 DATA_KV 即可使用

import { createSupabaseClient } from './supabase.js';
import { getClientIP, isBadBot, checkSecFetch, checkRateLimit, getRateLimitTier, maybeCleanup, isBlocked, blockIP, unblockIP, listBlockedIPs } from './anti-bot.js';

// KV 读取缓存 - 减少子请求数量（同一 invocation 内有效）
const kvCache = new Map();
function getKVCached(env, key, ttlMs = 60000) {
  const entry = kvCache.get(key);
  if (entry && (Date.now() - entry.ts) < ttlMs) {
    return entry.value;
  }
  const p = env.DATA_KV.get(key).then(v => {
    kvCache.set(key, { value: Promise.resolve(v), ts: Date.now() });
    return v;
  });
  kvCache.set(key, { value: p, ts: Date.now() });
  return p;
}

async function getAllKVKeys(env, prefix) {
  let keys = [];
  let cursor = undefined;
  while (true) {
    const list = await env.DATA_KV.list({ prefix, cursor });
    keys.push(...list.keys);
    if (list.list_complete || !list.cursor) {
      break;
    }
    cursor = list.cursor;
  }
  return keys;
}

async function getKVValuesConcurrently(env, keys) {
  const results = [];
  const concurrency = 30;
  for (let i = 0; i < keys.length; i += concurrency) {
    const chunk = keys.slice(i, i + concurrency);
    const promises = chunk.map(key => env.DATA_KV.get(key.name).then(val => ({ name: key.name, val })));
    const resolved = await Promise.all(promises);
    results.push(...resolved);
  }
  return results;
}

async function sendMarkdownMessage(env, target, content) {
  if (typeof target === 'string' && target.startsWith('https://')) {
    const whResp = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } })
    });
    if (!whResp.ok) {
      throw new Error('HTTP ' + whResp.status + ': ' + (await whResp.text()));
    }
    const body = await whResp.json();
    if (body.errcode !== 0) {
      throw new Error('WeChat API 错误 [' + body.errcode + ']: ' + (body.errmsg || '未知'));
    }
    return body;
  } else {
    throw new Error('无效的发送目标 (target)');
  }
}

// 关键问题列表（导出用，与客户端 KEY_QUESTIONS 保持同步）
const EXPORT_KEY_QUESTIONS = ['你们利息多少?','能贷多少额度?','你们费用怎么收?','怎么办理，需要什么资料?','多久能放款呢?','能不能办?能办下来吗?','我的负债比较高了！','查询比较多?','你们是银行吗?还是中介机构的?','需要抵押吗','需要电核吗','线下我都不相信了，根本办不了线下','晚上非工作时间通过微信的','电话中情绪比较低落的','听完贷款说在开会的','听完贷款说让加微信的','加了微信隔几天通过'];
function formatKeyQuestions(indices) {
  if (!indices || !indices.length) return '';
  var parts = [];
  for (var i = 0; i < indices.length; i++) {
    var idx = indices[i];
    if (idx >= 0 && idx < EXPORT_KEY_QUESTIONS.length) {
      parts.push(EXPORT_KEY_QUESTIONS[idx]);
    }
  }
  return parts.length > 0 ? parts.join('；') : '';
}

async function sendWebhookMarkdown(env, target, baseHeader, items, itemFormatter) {
  const enc = new TextEncoder();
  let currentText = baseHeader;
  let currentBytes = enc.encode(baseHeader).length;
  let part = 1;
  const sendChunk = async (content) => {
    await sendMarkdownMessage(env, target, content);
  };

  for (const item of items) {
    const itemText = itemFormatter(item);
    const itemBytes = enc.encode(itemText).length;
    if (currentBytes + itemBytes > 4000) {
      await sendChunk(currentText);
      part++;
      currentText = '### ' + (baseHeader.match(/###\s*([^\n]+)/)?.[1] || '导出数据') + ' (续' + part + ')\n\n---\n\n' + itemText;
      currentBytes = enc.encode(currentText).length;
    } else {
      currentText += itemText;
      currentBytes += itemBytes;
    }
  }
  if (currentText.length > 0) {
    await sendChunk(currentText);
  }
}


async function callAIChat(env, messages, temperature = 0.5, apiKeyOverride = '') {
  let provider = await getKVCached(env, 'config:ai_provider') || 'gemini';
  const visionKey = await getKVCached(env, 'config:vision_api_key') || '';
  const aiKey = await getKVCached(env, 'config:ai_api_key') || await getKVCached(env, 'config:deepseek_api_key') || env.AI_API_KEY || env.DEEPSEEK_API_KEY;

  let apiKey = apiKeyOverride || aiKey;
  if (!apiKeyOverride && (provider === 'gemini' || (visionKey && !aiKey))) {
    provider = 'gemini';
    apiKey = visionKey || aiKey;
  }

  let apiBase = await getKVCached(env, 'config:ai_api_base') || env.AI_API_BASE;
  let model = await getKVCached(env, 'config:ai_model') || env.AI_API_MODEL;

  // Defaults based on provider if not explicitly configured
  if (provider === 'gemini') {
    if (!apiBase) apiBase = 'https://generativelanguage.googleapis.com/v1beta/openai/';
    if (!model) model = 'gemini-2.5-flash';
  } else if (provider === 'deepseek') {
    if (!apiBase) apiBase = 'https://api.deepseek.com/v1/';
    if (!model) model = 'deepseek-chat';
  } else {
    // Custom OpenAI or default
    if (!apiBase) apiBase = 'https://api.deepseek.com/v1/';
    if (!model) model = 'deepseek-chat';
  }

  // Ensure trailing slash on apiBase, then append chat/completions
  let url = apiBase;
  if (!url.endsWith('/')) {
    url += '/';
  }
  url += 'chat/completions';

  if (!apiKey) {
    throw new Error('AI API Key is missing or not configured.');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
      temperature: temperature
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI API returned error [${response.status}]: ${errText}`);
  }

  return await response.json();
}

async function callAIChatWithTools(env, messages, temperature = 0.5, fromUser = '') {
  let provider = await env.DATA_KV.get('config:ai_provider') || 'gemini';
  const visionKey = await env.DATA_KV.get('config:vision_api_key') || '';
  const aiKey = await env.DATA_KV.get('config:ai_api_key') || await env.DATA_KV.get('config:deepseek_api_key') || env.AI_API_KEY || env.DEEPSEEK_API_KEY;
  
  let apiKey = aiKey;
  if (provider === 'gemini' || (visionKey && !aiKey)) {
    provider = 'gemini';
    apiKey = visionKey || aiKey;
  }
  
  let apiBase = await env.DATA_KV.get('config:ai_api_base') || env.AI_API_BASE;
  let model = await env.DATA_KV.get('config:ai_model') || env.AI_API_MODEL;

  if (provider === 'gemini') {
    if (!apiBase) apiBase = 'https://generativelanguage.googleapis.com/v1beta/openai/';
    if (!model) model = 'gemini-2.5-flash';
  } else if (provider === 'deepseek') {
    if (!apiBase) apiBase = 'https://api.deepseek.com/v1/';
    if (!model) model = 'deepseek-chat';
  } else {
    if (!apiBase) apiBase = 'https://api.deepseek.com/v1/';
    if (!model) model = 'deepseek-chat';
  }

  let url = apiBase;
  if (!url.endsWith('/')) {
    url += '/';
  }
  url += 'chat/completions';

  if (!apiKey) {
    throw new Error('AI API Key is missing or not configured.');
  }

  const tools = [
    {
      type: "function",
      function: {
        name: "search_customers",
        description: "从 Supabase 数据库中检索已归档的客户信息档案（支持按姓名、电话、公司等关键词模糊搜索）。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索关键词（如客户姓名、电话或单位名称）"
            }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_intent_clients",
        description: "从 Cloudflare KV 中读取指定日期的工作记录与客户登记列表（包含电话、时间、跟进情况/备注等）。",
        parameters: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "日期字符串，格式为 YYYY-MM-DD（例如 2026-06-04），不传则默认为今天"
            }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "check_company_whitelist",
        description: "在数据库白名单中核对某家公司是否属于银行白名单准入公司，以及具体的签约状态和准入银行。",
        parameters: {
          type: "object",
          properties: {
            companyName: {
              type: "string",
              description: "公司名称（如 腾讯科技、阿里巴巴 等）"
            }
          },
          required: ["companyName"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_knowledge_and_speech",
        description: "检索业务知识库、销售话术库以及贷款批贷案例记录。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "业务知识或话术关键词（如 贷款准入、开场白 等）"
            }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "export_data",
        description: "将统计数据或指定的意向客户导出推送到配置好的企业微信群机器人（Webhook）。可以导出本周数据、本月数据、全量客户，或者导出某位具体客户。",
        parameters: {
          type: "object",
          properties: {
            export_type: {
              type: "string",
              description: "导出数据类型。可选值: week (本周数据), month (本月数据), all_clients (合并发送全量客户表), all_clients_solo (逐条发送全量客户), single_client (导出指定客户的详细资料)",
              enum: ["week", "month", "all_clients", "all_clients_solo", "single_client"]
            },
            client_query: {
              type: "string",
              description: "导出单个客户资料时的搜索词 (仅当 export_type 是 single_client 时生效，例如客户的姓名或电话)"
            }
          },
          required: ["export_type"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "add_learning_material",
        description: "将销售原始素材（如微信聊天记录、电话录音转写文本、经典客户案例、企业政策等）进行AI提炼，并将其分类保存到学习管理知识库（Supabase）和今日锁屏背诵列表（KV）中。",
        parameters: {
          type: "object",
          properties: {
            source_type: {
              type: "string",
              description: "资料来源类型",
              enum: ["微信聊天", "电话录音", "客户案例", "企业资料"]
            },
            content: {
              type: "string",
              description: "需要被提炼的原始文本材料"
            },
            show: {
              type: "boolean",
              description: "是否在锁屏上显示，默认为 true"
            }
          },
          required: ["source_type", "content"]
        }
      }
    },
  ];

  let chatMessages = [...messages];
  let supabase = null;
  const getSupabase = () => {
    if (!supabase) supabase = createSupabaseClient(env);
    return supabase;
  };

  for (let loop = 0; loop < 5; loop++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: model,
        messages: chatMessages,
        temperature: temperature,
        tools: tools
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`AI API returned error [${response.status}]: ${errText}`);
    }

    const resJson = await response.json();
    const message = resJson.choices[0].message;
    chatMessages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return resJson;
    }

    for (const toolCall of message.tool_calls) {
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);
      let resultData = null;

      console.log(`[AIChatToolCall] calling ${functionName} with args:`, functionArgs);

      try {
        if (functionName === 'search_customers') {
          resultData = await getSupabase().searchCustomers(functionArgs.query);
        } else if (functionName === 'get_intent_clients') {
          let targetDate = functionArgs.date;
          if (!targetDate) {
            const d = new Date(Date.now() + 8 * 3600000);
            targetDate = d.toISOString().split('T')[0];
          }
          const raw = await env.DATA_KV.get(`work:${targetDate}`);
          resultData = raw ? JSON.parse(raw) : { message: `该日期 (${targetDate}) 暂无意向客户或工作汇报记录。` };
        } else if (functionName === 'check_company_whitelist') {
          resultData = await getSupabase().checkCompanies([functionArgs.companyName]);
        } else if (functionName === 'search_knowledge_and_speech') {
          const [knowledges, speechs, cases] = await Promise.all([
            getSupabase().searchKnowledge(functionArgs.query),
            getSupabase().searchSpeech(functionArgs.query),
            getSupabase().searchLoanCases(functionArgs.query)
          ]);
          resultData = { knowledges, speechs, cases };
        } else if (functionName === 'export_data') {
          const webhookUrl = await env.DATA_KV.get('config:webhook_url');
          let target;
          if (!webhookUrl || webhookUrl.trim() === '') {
            resultData = { error: '请先在网页端配置企业微信群 Webhook URL' };
          } else {
            const target = webhookUrl.trim();
            const type = functionArgs.export_type;
            if (type === 'single_client') {
              const query = functionArgs.client_query;
              if (!query) {
                resultData = { error: '导出单个客户需要提供 client_query 参数！' };
              } else {
                const keys = await getAllKVKeys(env, 'work:');
                const keyValues = await getKVValuesConcurrently(env, keys);
                const allClients = [];
                for (const kv of keyValues) {
                  if (kv.val) {
                    try {
                      const d = JSON.parse(kv.val);
                      if (d.clients) {
                        d.clients.forEach(c => {
                          allClients.push({ ...c, date: c.date || kv.name.replace('work:', '') });
                        });
                      }
                    } catch(e) {}
                  }
                }
                const client = allClients.find(c =>
                  (c.name && c.name.includes(query)) ||
                  (c.phone && c.phone.includes(query))
                );
                if (!client) {
                  resultData = { error: `未找到匹配“${query}”的意向客户` };
                } else {
                  const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
                  const datePart = (client.date || '').slice(5);
                  const wk = client.date ? ' 周' + weekNames[new Date(client.date + 'T00:00:00').getDay()] : '';
                  
                  let text = '> 姓名：' + client.name + '\n';
                  text += '> 日期: ' + datePart + wk + ' | 时间: ' + (client.time || '—') + '\n';
                  text += '> 电话: ' + (client.phone || '—') + '\n';
                  text += '> 单位: ' + (client.company || '—') + ' | 公积金: ' + (client.fund || '—') + '\n';
                  if (client.note) text += '> 沟通: ' + client.note.replace(/\n/g, ' ') + '\n';
                  if (client.followUp) text += '> 跟进: ' + client.followUp.replace(/\n/g, ' ') + '\n';
                  const detailParts = [];
                  if (client.age) detailParts.push('年龄:' + client.age);
                  if (client.maritalStatus) detailParts.push(client.maritalStatus);
                  if (client.isShenzhenHukou) detailParts.push('深户:' + client.isShenzhenHukou);
                  if (client.education) detailParts.push(client.education);
                  if (client.property) detailParts.push(client.property);
                  if (client.propertyType) detailParts.push(client.propertyType);
                  if (client.propertyAddress) detailParts.push('房产地址:' + client.propertyAddress);
                  if (client.propertyArea) detailParts.push('面积:' + client.propertyArea);
                  if (client.propertyMortgageBank) detailParts.push('抵押:' + client.propertyMortgageBank);
                  if (client.propertyMortgageAmount) detailParts.push('欠款:' + client.propertyMortgageAmount);
                  if (client.propertyOther) detailParts.push('房产备注:' + client.propertyOther);
                  if (client.socialSecurity) detailParts.push('社保基数:' + client.socialSecurity);
                  if (client.avgSalary) detailParts.push('月均工资:' + client.avgSalary);
                  if (client.tax2yr) detailParts.push('近2年个税:' + client.tax2yr);
                  if (client.salaryBank) detailParts.push('代发银行:' + client.salaryBank);
                  if (client.bankDebt) detailParts.push('信贷负债:' + client.bankDebt);
                  if (client.creditCardDebt) detailParts.push('信用卡负债:' + client.creditCardDebt);
                  if (client.query3m) detailParts.push('近3月查询:' + client.query3m + '次');
                  if (client.onlineLoanCount) detailParts.push('网贷笔数:' + client.onlineLoanCount);
                  if (detailParts.length > 0) text += '> ' + detailParts.join(' | ') + '\n';
                  if (client.demand) text += '> 需求: ' + client.demand.replace(/\n/g, ' ') + '\n';
                  if (client.fundUsage) text += '> 资金用途: ' + client.fundUsage.replace(/\n/g, ' ') + '\n';
                  var kqAi = formatKeyQuestions(client.keyQuestions);
                  if (kqAi) text += '> 关键问题：' + kqAi + '\n';

                  try {
                    await sendMarkdownMessage(env, target, text);
                    resultData = { success: true, message: `已成功导出客户【${client.name}】到企业微信。` };
                  } catch (e) {
                    resultData = { error: `导出失败，接口返回错误: ${e.message}` };
                  }
                }
              }
            } else if (type === 'all_clients' || type === 'all_clients_solo') {
              const keys = await getAllKVKeys(env, 'work:');
              const keyValues = await getKVValuesConcurrently(env, keys);
              const allClients = [];
              for (const kv of keyValues) {
                if (kv.val) {
                  try {
                    const d = JSON.parse(kv.val);
                    if (d.clients) {
                      d.clients.forEach(c => {
                        allClients.push({ ...c, date: c.date || kv.name.replace('work:', '') });
                      });
                    }
                  } catch(e) {}
                }
              }
              allClients.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

              if (type === 'all_clients') {
                const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
                const total = allClients.length;
                const baseHeader = '### 意向客户全量表\n> 共计 **' + total + '** 位意向客户\n\n---\n\n';
                const itemFormatter = (c) => {
                  const datePart = (c.date || '').slice(5);
                  const wk = c.date ? ' 周' + weekNames[new Date(c.date + 'T00:00:00').getDay()] : '';
                  let itemText = '> 姓名：' + c.name + '\n';
                  itemText += '> 日期: ' + datePart + wk + ' | 时间: ' + (c.time || '—') + '\n';
                  itemText += '> 电话: ' + (c.phone || '—') + '\n';
                  itemText += '> 单位: ' + (c.company || '—') + ' | 公积金: ' + (c.fund || '—') + '\n';
                  if (c.note) itemText += '> 沟通: ' + c.note.replace(/\n/g, ' ') + '\n';
                  if (c.followUp) itemText += '> 跟进: ' + c.followUp.replace(/\n/g, ' ') + '\n';
                  var dp = [];
                  if (c.age) dp.push('年龄:' + c.age);
                  if (c.maritalStatus) dp.push(c.maritalStatus);
                  if (c.isShenzhenHukou) dp.push('深户:' + c.isShenzhenHukou);
                  if (c.education) dp.push(c.education);
                  if (c.property) dp.push(c.property);
                  if (c.propertyType) dp.push(c.propertyType);
                  if (c.propertyAddress) dp.push('房产地址:' + c.propertyAddress);
                  if (c.propertyArea) dp.push('面积:' + c.propertyArea);
                  if (c.propertyMortgageBank) dp.push('抵押:' + c.propertyMortgageBank);
                  if (c.propertyMortgageAmount) dp.push('欠款:' + c.propertyMortgageAmount);
                  if (c.propertyOther) dp.push('房产备注:' + c.propertyOther);
                  if (c.socialSecurity) dp.push('社保基数:' + c.socialSecurity);
                  if (c.avgSalary) dp.push('月均工资:' + c.avgSalary);
                  if (c.tax2yr) dp.push('近2年个税:' + c.tax2yr);
                  if (c.salaryBank) dp.push('代发银行:' + c.salaryBank);
                  if (c.bankDebt) dp.push('信贷负债:' + c.bankDebt);
                  if (c.creditCardDebt) dp.push('信用卡负债:' + c.creditCardDebt);
                  if (c.query3m) dp.push('近3月查询:' + c.query3m + '次');
                  if (c.onlineLoanCount) dp.push('网贷笔数:' + c.onlineLoanCount);
                  if (dp.length > 0) itemText += '> ' + dp.join(' | ') + '\n';
                  if (c.demand) itemText += '> 需求: ' + c.demand.replace(/\n/g, ' ') + '\n';
                  if (c.fundUsage) itemText += '> 资金用途: ' + c.fundUsage.replace(/\n/g, ' ') + '\n';
                  var kqAiBulk = formatKeyQuestions(c.keyQuestions);
                  if (kqAiBulk) itemText += '> 关键问题：' + kqAiBulk + '\n';
                  itemText += '\n';
                  return itemText;
                };

                try {
                  await sendWebhookMarkdown(env, target, baseHeader, allClients, itemFormatter);
                  resultData = { success: true, message: `已成功合并导出全部共 ${total} 位意向客户到企业微信。` };
                } catch (e) {
                  resultData = { error: `导出失败: ${e.message}` };
                }
              } else {
                const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
                const buildText = (c) => {
                  const datePart = (c.date || '').slice(5);
                  const wk = c.date ? ' 周' + weekNames[new Date(c.date + 'T00:00:00').getDay()] : '';
                  let text = '> 姓名：' + c.name + '\n';
                  text += '> 日期: ' + datePart + wk + ' | 时间: ' + (c.time || '—') + '\n';
                  text += '> 电话: ' + (c.phone || '—') + '\n';
                  text += '> 单位: ' + (c.company || '—') + ' | 公积金: ' + (c.fund || '—') + '\n';
                  if (c.note) text += '> 沟通: ' + c.note.replace(/\n/g, ' ') + '\n';
                  if (c.followUp) text += '> 跟进: ' + c.followUp.replace(/\n/g, ' ') + '\n';
                  var dp2 = [];
                  if (c.age) dp2.push('年龄:' + c.age);
                  if (c.maritalStatus) dp2.push(c.maritalStatus);
                  if (c.isShenzhenHukou) dp2.push('深户:' + c.isShenzhenHukou);
                  if (c.education) dp2.push(c.education);
                  if (c.property) dp2.push(c.property);
                  if (c.propertyType) dp2.push(c.propertyType);
                  if (c.propertyAddress) dp2.push('房产地址:' + c.propertyAddress);
                  if (c.propertyArea) dp2.push('面积:' + c.propertyArea);
                  if (c.propertyMortgageBank) dp2.push('抵押:' + c.propertyMortgageBank);
                  if (c.propertyMortgageAmount) dp2.push('欠款:' + c.propertyMortgageAmount);
                  if (c.propertyOther) dp2.push('房产备注:' + c.propertyOther);
                  if (c.socialSecurity) dp2.push('社保基数:' + c.socialSecurity);
                  if (c.avgSalary) dp2.push('月均工资:' + c.avgSalary);
                  if (c.tax2yr) dp2.push('近2年个税:' + c.tax2yr);
                  if (c.salaryBank) dp2.push('代发银行:' + c.salaryBank);
                  if (c.bankDebt) dp2.push('信贷负债:' + c.bankDebt);
                  if (c.creditCardDebt) dp2.push('信用卡负债:' + c.creditCardDebt);
                  if (c.query3m) dp2.push('近3月查询:' + c.query3m + '次');
                  if (c.onlineLoanCount) dp2.push('网贷笔数:' + c.onlineLoanCount);
                  if (dp2.length > 0) text += '> ' + dp2.join(' | ') + '\n';
                  if (c.demand) text += '> 需求: ' + c.demand.replace(/\n/g, ' ') + '\n';
                  if (c.fundUsage) text += '> 资金用途: ' + c.fundUsage.replace(/\n/g, ' ') + '\n';
                  var kqAiSolo = formatKeyQuestions(c.keyQuestions);
                  if (kqAiSolo) text += '> 关键问题：' + kqAiSolo + '\n';
                  return text;
                };

                let sent = 0, failed = 0;
                const concurrency = 3;
                for (let i = 0; i < allClients.length; i += concurrency) {
                  const batch = allClients.slice(i, i + concurrency);
                  const results = await Promise.all(batch.map(async (c) => {
                    try {
                      await sendMarkdownMessage(env, target, buildText(c));
                      return true;
                    } catch(e) { return false; }
                  }));
                  for (const r of results) {
                    if (r) sent++; else failed++;
                  }
                }
                resultData = { success: true, message: `逐条导出完成：共 ${allClients.length} 条，成功 ${sent} 条，失败 ${failed} 条。` };
              }
            } else if (type === 'temp_clients') {
              const list = body.tempClients || [];
              const total = list.length;
              const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
              const baseHeader = '### 临时登记全量表\n> 共计 **' + total + '** 人\n\n---\n\n';
              const itemFormatter = (c) => {
                const datePart = (c.date || '').slice(5);
                const wk = c.date ? ' 周' + weekNames[new Date(c.date + 'T00:00:00').getDay()] : '';
                let itemText = '> 客户姓名：' + c.name + '\n';
                itemText += '> 日期：' + datePart + wk + ' | 时间：' + (c.time || '') + '\n';
                itemText += '> 电话：' + (c.phone || '') + '\n';
                itemText += '> 单位名称：' + (c.company || '') + '\n';
                itemText += '> 公积金：' + (c.fund || '') + '\n';
                itemText += '> 沟通内容：' + (c.note || '').replace(/\n/g, ' ') + '\n';
                if (c.followUps && c.followUps.length > 0) {
                  itemText += '> 跟进记录：\n';
                  c.followUps.forEach(function(fu) {
                    itemText += '>   [' + (fu.date || '') + ' ' + (fu.time || '') + '] ' + (fu.content || '').replace(/\n/g, ' ') + '\n';
                  });
                }
                var kqTc = formatKeyQuestions(c.keyQuestions);
                if (kqTc) itemText += '> 关键问题：' + kqTc + '\n';
                itemText += '\n';
                return itemText;
              };
              try {
                await sendWebhookMarkdown(env, target, baseHeader, list, itemFormatter);
                resultData = { success: true, message: '已成功导出全部共 ' + total + ' 位临时登记客户到企业微信。' };
              } catch (e) {
                resultData = { error: '导出失败: ' + e.message };
              }
            } else if (type === 'week' || type === 'month') {
              const today = new Date();
              const dow = today.getDay();
              const diff = dow === 0 ? 6 : dow - 1;
              const mon = new Date(today);
              mon.setDate(today.getDate() - diff);
              const monStr = mon.getFullYear() + '-' + String(mon.getMonth()+1).padStart(2,'0') + '-' + String(mon.getDate()).padStart(2,'0');
              const todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
              const monthPrefix = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0');

              const keys = await getAllKVKeys(env, 'work:' + monthPrefix);
              const keyValues = await getKVValuesConcurrently(env, keys);
              let weekW = 0, monthW = 0, weekI = 0, monthI = 0, weekR = 0, monthR = 0, weekT = 0, monthT = 0;
              const sorted = [];
              for (const kv of keyValues) {
                if (!kv.val) continue;
                try {
                  const d = JSON.parse(kv.val);
                  sorted.push(d);
                  monthW += d.wechatCount || 0;
                  monthI += d.intentCount || 0;
                  monthR += d.revisitCount || 0;
                  monthT += (d.tempClients || []).filter(function(tc){ return !tc.date || tc.date === d.date; }).length;
                  if (d.date >= monStr && d.date <= todayStr) {
                    weekW += d.wechatCount || 0;
                    weekI += d.intentCount || 0;
                    weekR += d.revisitCount || 0;
                    weekT += (d.tempClients || []).filter(function(tc){ return !tc.date || tc.date === d.date; }).length;
                  }
                } catch(e) {}
              }
              sorted.sort((a,b) => (a.date||'').localeCompare(b.date||''));

              const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
              const title = type === 'week' ? '本周数据统计' : '本月数据统计';
              const dateRange = type === 'week'
                ? monStr + ' ～ ' + todayStr
                : monthPrefix + '-01 ～ ' + todayStr;
              const wTotal = type === 'week' ? weekW : monthW;
              const iTotal = type === 'week' ? weekI : monthI;
              const rTotal = type === 'week' ? weekR : monthR;
              const tTotal = type === 'week' ? weekT : monthT;

              const baseHeader = '### ' + title + '\n' +
                '> ' + dateRange + '\n\n' +
                '<font color="info">新增微信：**' + wTotal + '**</font>\n' +
                '<font color="warning">新增意向：**' + iTotal + '**</font>\n' +
                '<font color="comment">客户回访：**' + rTotal + '**</font>\n' +
                '<font color="comment">临时登记：**' + tTotal + '** 人</font>\n' +
                (type !== 'week' ? '\n> 本周参考: 微信 **' + weekW + '** | 意向 **' + weekI + '** | 回访 **' + weekR + '** | 临时 **' + weekT + '**\n' : '') +
                '\n---\n\n';

              const activeDays = sorted.filter(d => {
                if (type === 'week' && (d.date < monStr || d.date > todayStr)) return false;
                return true;
              });

              const itemFormatter = (d) => {
                const datePart = d.date.slice(5);
                const wk = '周' + weekNames[new Date(d.date + 'T00:00:00').getDay()];
                const w = d.wechatCount || 0;
                const it = d.intentCount || 0;
                const r = d.revisitCount || 0;
                
                const clients = d.clients || [];
                let detail = '';
                if (clients.length > 0) {
                  detail = clients.map(c => c.name + (c.company ? ' [' + c.company + ']' : '') + (c.fund ? ' {' + c.fund + '}' : '') + (c.note ? ' （' + c.note + '）' : '')).join('\n> ');
                } else {
                  detail = '*(无新增意向)*';
                }
                
                let itemText = '**' + datePart + ' ' + wk + '\n';
                itemText += '> <font color="info">微信: ' + w + '</font> | <font color="warning">意向: ' + it + '</font> | <font color="comment">回访: ' + r + '</font>\n';
                itemText += '> ' + detail + '\n\n';
                return itemText;
              };

              try {
                await sendWebhookMarkdown(env, target, baseHeader, activeDays, itemFormatter);
                resultData = { success: true, message: `已成功导出${title}数据到企业微信。` };
              } catch (e) {
                resultData = { error: `导出失败: ${e.message}` };
              }
            }
          }
        } else if (functionName === 'add_learning_material') {
          const sourceType = functionArgs.source_type;
          const content = functionArgs.content;
          const showOnLock = functionArgs.show !== undefined ? functionArgs.show : true;

          const hasKey = await env.DATA_KV.get('config:ai_api_key') || await env.DATA_KV.get('config:deepseek_api_key') || await env.DATA_KV.get('config:vision_api_key') || env.AI_API_KEY || env.DEEPSEEK_API_KEY;
          let parsedResult = null;

          if (!hasKey) {
            const mockTitles = {
              '微信聊天': '微信客情维护与意向跟进',
              '电话录音': '电话触客异议处理技巧',
              '客户案例': '经典贷款获获实战案例',
              '企业资料': '银行准入与利息政策详解'
            };
            const mockTags = {
              '微信聊天': ['微信', '跟进'],
              '电话录音': ['电话', '话术'],
              '客户案例': ['批贷案例', '建易贷'],
              '企业资料': ['企业准入', '白名单']
            };
            const title = mockTitles[sourceType] || '自主学习提炼';
            const tags = mockTags[sourceType] || ['学习', '业务知识'];
            const summary = content.length > 30 ? content.slice(0, 27) + '...' : content;
            parsedResult = {
              title: title,
              summary: summary,
              content: '（模拟AI提炼）\n' + content,
              tags: tags,
              source_type: sourceType
            };
          } else {
            try {
              const apiData = await callAIChat(env, [
                {
                  role: 'system',
                  content: '你是一个智能贷款销售学习助手。根据用户提供的销售原始材料（微信聊天记录、电话录音文本、客户案例、或企业资料），进行深度提炼，总结出可以直接用于锁屏学习、话术背诵、业务记忆的核心知识。\n\n请必须只输出以下 JSON 格式的字符串（不要包裹 markdown 代码块，如 ```json，只需输出 JSON 本身）：\n{\n  "title": "提炼的知识标题 (15字以内)",\n  "summary": "一句话摘要 (30字以内)",\n  "content": "提炼的核心话术/知识要点 (150字以内)",\n  "tags": ["标签1", "标签2"]\n}'
                },
                {
                  role: 'user',
                  content: `来源类型: ${sourceType}\n\n内容:\n${content}`
                }
              ], 0.3, hasKey);

              let aiContent = apiData.choices[0].message.content.trim();
              if (aiContent.startsWith('```')) {
                aiContent = aiContent.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
              }
              parsedResult = JSON.parse(aiContent);
              parsedResult.source_type = sourceType;
            } catch (aiErr) {
              parsedResult = {
                title: '提炼知识 - ' + sourceType,
                summary: 'AI提炼失败退回',
                content: content,
                tags: ['学习'],
                source_type: sourceType
              };
            }
          }

          // Save to Supabase
          try {
            await getSupabase().saveKnowledge(parsedResult);
          } catch(se) {
            console.error('[supabase] saveKnowledge error:', se.message);
          }

          // Save to KV learns array
          const d = new Date(Date.now() + 8 * 3600000);
          const todayDate = d.toISOString().split('T')[0];
          const raw = await env.DATA_KV.get(`work:${todayDate}`);
          const data = raw ? JSON.parse(raw) : {
            date: todayDate, wechatCount: 0, intentCount: 0, revisitCount: 0, visitCount: 0, paymentCount: 0, clients: [],
            todayTodos: [], tomorrowTodos: [], tempClients: [], scripts: [], learns: [], todoLog: []
          };
          if (!data.learns) data.learns = [];
          
          const newItem = {
            title: parsedResult.title,
            summary: parsedResult.summary,
            content: parsedResult.content,
            tags: parsedResult.tags,
            source_type: parsedResult.source_type,
            show: showOnLock
          };
          data.learns.unshift(newItem);
          resultData = { error: `Unknown tool: ${functionName}` };
        }
      } catch (err) {
        console.error(`[AIChatToolCall] Error running ${functionName}:`, err);
        resultData = { error: `Failed to execute: ${err.message}` };
      }

      chatMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: functionName,
        content: JSON.stringify(resultData)
      });
    }
  }

  return { choices: [{ message: chatMessages[chatMessages.length - 1] }] };
}

// ========== Dialer Auth Helpers ==========

function dialerHashPin(str) {
  var hash = 5381;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function dialerGenToken() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
}

async function dialerGetAccounts(env) {
  var raw = await env.DATA_KV.get('dialer:accounts');
  return raw ? JSON.parse(raw) : [];
}

async function dialerSaveAccounts(env, accounts) {
  await env.DATA_KV.put('dialer:accounts', JSON.stringify(accounts));
}

async function dialerValidateSession(env, token) {
  if (!token) return null;
  var raw = await env.DATA_KV.get('dialer:session:' + token);
  if (!raw) return null;
  return JSON.parse(raw);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const needsKV = (
      path === '/api/dialer/data' ||
      path === '/api/data' ||
      path === '/api/sync' ||
      path === '/api/calendar' ||
      path === '/api/stats' ||
      path === '/api/all-clients' ||
      path === '/api/export'
    );
    if (needsKV && !env.DATA_KV) {
      return new Response(JSON.stringify({ error: 'DATA_KV binding is missing or not configured.' }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // CORS preflight handler (skip all anti-bot checks for preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // ==================== 反爬防护中间件 ====================
    const clientIP = getClientIP(request);

    // 1. IP 黑名单检查
    if (!path.startsWith('/api/admin/blocked-ips')) { // 管理端点自身不检查黑名单
      const blockCheck = await isBlocked(env, clientIP);
      if (blockCheck.blocked) {
        return new Response(JSON.stringify({
          error: 'Access denied',
          reason: blockCheck.reason,
          blockedAt: blockCheck.blockedAt,
        }), {
          status: 403,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*',
          }
        });
      }
    }

    // 2. 恶意 UA 检测
    const uaCheck = isBadBot(request.headers.get('User-Agent'));
    if (uaCheck.blocked) {
      return new Response(JSON.stringify({
        error: 'Access denied',
        reason: uaCheck.reason,
      }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // 3. Sec-Fetch 头验证（仅标记可疑，不硬拦截 — 但配合其他信号升级）
    const secFetchCheck = checkSecFetch(request);

    // 4. 速率限制
    const rateLimitTier = getRateLimitTier(path);
    const rateCheck = checkRateLimit(clientIP, rateLimitTier);
    // 如果 Sec-Fetch 异常 + 超限，说明很可能是自动化脚本
    if (rateCheck.limited) {
      return new Response(JSON.stringify({
        error: 'Too Many Requests',
        retryAfter: rateCheck.retryAfter,
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Access-Control-Allow-Origin': '*',
          'Retry-After': String(rateCheck.retryAfter),
        }
      });
    }

    // 5. 蜜罐陷阱 — 自动封禁
    if (path === '/api/trap') {
      await blockIP(env, clientIP, 'honeypot_trap');
      return new Response(JSON.stringify({ error: 'Access denied' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // 定期清理速率限制过期条目
    maybeCleanup();

    // Supabase client (no-op if SUPABASE_URL/KEY not set)
    const supabase = createSupabaseClient(env);

    // Debug helper to check env keys (returns only keys, no values for safety)
    if (path === '/api/debug-env' && request.method === 'GET') {
      return new Response(JSON.stringify({ keys: Object.keys(env || {}) }), {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ==================== 拨号器账户认证 ====================

    // Auth: check if any accounts exist
    if (path === '/api/dialer/auth/status' && request.method === 'POST') {
      try {
        var accounts = await dialerGetAccounts(env);
        return new Response(JSON.stringify({ has_accounts: accounts.length > 0, count: accounts.length }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Auth: reset all accounts (clear everything, start fresh)
    if (path === '/api/dialer/auth/reset' && request.method === 'POST') {
      try {
        var accounts = await dialerGetAccounts(env);
        var count = accounts.length;
        // Clear all accounts
        await env.DATA_KV.put('dialer:accounts', JSON.stringify([]));
        // Clear all sessions (list and delete pattern not available, just overwrite accounts)
        return new Response(JSON.stringify({ success: true, cleared: count }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Auth: first-time setup (create master account)
    if (path === '/api/dialer/auth/setup' && request.method === 'POST') {
      try {
        var body = await request.json();
        var accountName = (body.account_name || '').trim();
        var pin = (body.pin || '').trim();
        var label = (body.label || accountName || '').trim();
        if (!accountName) throw new Error('请输入账户名');
        if (pin.length < 4) throw new Error('PIN 至少需要 4 位数字');

        var accounts = await dialerGetAccounts(env);
        if (accounts.length > 0) throw new Error('已有账户存在，无法重复初始化');
        // Check name uniqueness
        for (var an = 0; an < accounts.length; an++) {
          if (accounts[an].account_name === accountName) throw new Error('账户名已存在');
        }

        var accountId = 'acct_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        var pinHash = dialerHashPin(pin);
        var account = {
          account_id: accountId, account_name: accountName, pin_hash: pinHash, label: label,
          is_master: true, active: true, created_at: new Date().toISOString()
        };
        accounts.push(account);
        await dialerSaveAccounts(env, accounts);

        // Create session
        var token = dialerGenToken();
        await env.DATA_KV.put('dialer:session:' + token, JSON.stringify({ account_id: accountId, created_at: new Date().toISOString() }));

        return new Response(JSON.stringify({ success: true, account_id: accountId, is_master: true, label: label, session_token: token }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Auth: login
    if (path === '/api/dialer/auth/login' && request.method === 'POST') {
      try {
        var body = await request.json();
        var accountName = (body.account_name || '').trim();
        var pin = (body.pin || '').trim();
        if (!accountName || pin.length < 4) throw new Error('请输入账户名和 PIN 码');

        var accounts = await dialerGetAccounts(env);
        var account = null;
        for (var ai = 0; ai < accounts.length; ai++) {
          if (accounts[ai].account_name === accountName || accounts[ai].account_id === accountName) { account = accounts[ai]; break; }
        }
        if (!account) throw new Error('账户不存在');
        if (!account.active) throw new Error('该账户已被禁用');
        if (account.pin_hash !== dialerHashPin(pin)) throw new Error('PIN 码错误');

        var accountId = account.account_id;

        // Create session
        var token = dialerGenToken();
        await env.DATA_KV.put('dialer:session:' + token, JSON.stringify({ account_id: accountId, created_at: new Date().toISOString() }));

        return new Response(JSON.stringify({
          success: true, account_id: accountId, is_master: account.is_master !== false,
          label: account.label || '', session_token: token
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Auth: list accounts (for login screen — returns id+label only, no pin_hash)
    if (path === '/api/dialer/auth/accounts' && request.method === 'GET') {
      try {
        var accounts = await dialerGetAccounts(env);
        var safe = accounts.map(function(a) {
          return { account_id: a.account_id, account_name: a.account_name || '', label: a.label || '', is_master: a.is_master !== false, active: a.active, created_at: a.created_at };
        });
        return new Response(JSON.stringify({ accounts: safe }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Auth: create sub-account (master only, requires session)
    if (path === '/api/dialer/auth/accounts' && request.method === 'POST') {
      try {
        var authHeader = request.headers.get('Authorization') || '';
        var sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        var session = await dialerValidateSession(env, sessionToken);
        if (!session) throw new Error('未登录');

        var accounts = await dialerGetAccounts(env);
        var master = null;
        for (var ai2 = 0; ai2 < accounts.length; ai2++) {
          if (accounts[ai2].account_id === session.account_id) { master = accounts[ai2]; break; }
        }
        if (!master || !master.is_master) throw new Error('仅主账户可创建子账户');

        var body = await request.json();
        var accountName = (body.account_name || '').trim();
        var pin = (body.pin || '').trim();
        var label = (body.label || accountName || '').trim();
        if (!accountName) throw new Error('请输入账户名');
        if (pin.length < 4) throw new Error('PIN 至少需要 4 位数字');
        // Check name uniqueness
        for (var sn = 0; sn < accounts.length; sn++) {
          if (accounts[sn].account_name === accountName) throw new Error('账户名已存在');
        }

        var subId = 'sub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        var subAccount = {
          account_id: subId, account_name: accountName, pin_hash: dialerHashPin(pin), label: label,
          is_master: false, active: true, created_at: new Date().toISOString()
        };
        accounts.push(subAccount);
        await dialerSaveAccounts(env, accounts);

        return new Response(JSON.stringify({ success: true, account_id: subId, label: label }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: e.message === '未登录' ? 401 : 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Auth: update sub-account (toggle active/label, master only)
    if (path === '/api/dialer/auth/accounts' && request.method === 'PATCH') {
      try {
        var authHeader = request.headers.get('Authorization') || '';
        var sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        var session = await dialerValidateSession(env, sessionToken);
        if (!session) throw new Error('未登录');

        var accounts = await dialerGetAccounts(env);
        var master = null;
        for (var ai3 = 0; ai3 < accounts.length; ai3++) {
          if (accounts[ai3].account_id === session.account_id) { master = accounts[ai3]; break; }
        }
        if (!master || !master.is_master) throw new Error('仅主账户可管理子账户');

        var body = await request.json();
        var targetId = (body.target_account_id || '').trim();
        if (!targetId) throw new Error('缺少目标账户 ID');
        if (targetId === master.account_id) throw new Error('不能修改主账户');

        var found = false;
        for (var ai4 = 0; ai4 < accounts.length; ai4++) {
          if (accounts[ai4].account_id === targetId) {
            if (body.active !== undefined) accounts[ai4].active = !!body.active;
            if (body.label !== undefined) accounts[ai4].label = String(body.label).trim();
            found = true;
            break;
          }
        }
        if (!found) throw new Error('子账户不存在');
        await dialerSaveAccounts(env, accounts);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: e.message === '未登录' ? 401 : 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Auth: delete sub-account (master only)
    if (path === '/api/dialer/auth/accounts' && request.method === 'DELETE') {
      try {
        var authHeader = request.headers.get('Authorization') || '';
        var sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        var session = await dialerValidateSession(env, sessionToken);
        if (!session) throw new Error('未登录');

        var accounts = await dialerGetAccounts(env);
        var master = null;
        for (var ai5 = 0; ai5 < accounts.length; ai5++) {
          if (accounts[ai5].account_id === session.account_id) { master = accounts[ai5]; break; }
        }
        if (!master || !master.is_master) throw new Error('仅主账户可删除子账户');

        var body = await request.json();
        var targetId = (body.target_account_id || '').trim();
        if (!targetId) throw new Error('缺少目标账户 ID');
        if (targetId === master.account_id) throw new Error('不能删除主账户');

        var newList = [];
        for (var ai6 = 0; ai6 < accounts.length; ai6++) {
          if (accounts[ai6].account_id !== targetId) newList.push(accounts[ai6]);
        }
        if (newList.length === accounts.length) throw new Error('子账户不存在');
        await dialerSaveAccounts(env, newList);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: e.message === '未登录' ? 401 : 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Auth: change own PIN (any logged-in account)
    if (path === '/api/dialer/auth/change-pin' && request.method === 'POST') {
      try {
        var authHeader = request.headers.get('Authorization') || '';
        var sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        var session = await dialerValidateSession(env, sessionToken);
        if (!session) throw new Error('未登录');

        var body = await request.json();
        var oldPin = (body.old_pin || '').trim();
        var newPin = (body.new_pin || '').trim();
        if (oldPin.length < 4) throw new Error('请输入当前 PIN');
        if (newPin.length < 4) throw new Error('新 PIN 至少需要 4 位');

        var accounts = await dialerGetAccounts(env);
        var found = false;
        for (var ai7 = 0; ai7 < accounts.length; ai7++) {
          if (accounts[ai7].account_id === session.account_id) {
            if (accounts[ai7].pin_hash !== dialerHashPin(oldPin)) throw new Error('当前 PIN 码错误');
            accounts[ai7].pin_hash = dialerHashPin(newPin);
            found = true;
            break;
          }
        }
        if (!found) throw new Error('账户不存在');
        await dialerSaveAccounts(env, accounts);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: e.message === '未登录' ? 401 : 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Auth: account upload stats (master only, for dashboard)
    if (path === '/api/dialer/stats/accounts' && request.method === 'GET') {
      try {
        var authHeader = request.headers.get('Authorization') || '';
        var sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        var session = await dialerValidateSession(env, sessionToken);
        if (!session) throw new Error('未登录');

        var accounts = await dialerGetAccounts(env);
        var master = null;
        for (var ak = 0; ak < accounts.length; ak++) {
          if (accounts[ak].account_id === session.account_id) { master = accounts[ak]; break; }
        }
        if (!master || !master.is_master) throw new Error('仅主账户可查看');

        // Query Supabase for customer counts per account_id
        var supabaseUrl = env.SUPABASE_URL;
        var supabaseKey = env.SUPABASE_KEY;
        var stats = [];

        if (supabaseUrl && supabaseKey) {
          var hdrs = {
            'apikey': supabaseKey,
            'Authorization': 'Bearer ' + supabaseKey
          };
          // Fetch all customer account_ids (limited)
          var resp = await fetch(
            supabaseUrl + '/rest/v1/customers?select=account_id&limit=10000',
            { headers: Object.assign({}, hdrs, { 'Accept': 'application/json' }) }
          );
          if (resp.ok) {
            var rows = await resp.json();
            // Count by account_id
            var countMap = {};
            for (var ri = 0; ri < rows.length; ri++) {
              var aid = rows[ri].account_id || '_unknown';
              countMap[aid] = (countMap[aid] || 0) + 1;
            }
            // Merge with account names
            for (var ak2 = 0; ak2 < accounts.length; ak2++) {
              var a = accounts[ak2];
              stats.push({
                account_id: a.account_id,
                account_name: a.account_name || a.label || a.account_id.slice(0, 12),
                label: a.label || '',
                is_master: a.is_master !== false,
                active: a.active,
                upload_count: countMap[a.account_id] || 0
              });
            }
            // Add unknown accounts (data without matching account)
            for (var ck in countMap) {
              if (ck !== '_unknown' && !accounts.some(function(a) { return a.account_id === ck; })) {
                stats.push({
                  account_id: ck,
                  account_name: ck.slice(0, 12),
                  label: '',
                  is_master: false,
                  active: true,
                  upload_count: countMap[ck]
                });
              }
            }
          }
        }

        return new Response(JSON.stringify({ stats: stats, unknown_count: countMap ? (countMap['_unknown'] || 0) : 0 }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Auth: migrate unowned customers to master (one-click)
    if (path === '/api/dialer/stats/migrate' && request.method === 'POST') {
      try {
        var authHeader = request.headers.get('Authorization') || '';
        var sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        var session = await dialerValidateSession(env, sessionToken);
        if (!session) throw new Error('未登录');

        var accounts = await dialerGetAccounts(env);
        var master = null;
        for (var ak3 = 0; ak3 < accounts.length; ak3++) {
          if (accounts[ak3].account_id === session.account_id && accounts[ak3].is_master !== false) { master = accounts[ak3]; break; }
        }
        if (!master) throw new Error('仅主账户可操作');

        var supabaseUrl = env.SUPABASE_URL;
        var supabaseKey = env.SUPABASE_KEY;
        if (!supabaseUrl || !supabaseKey) throw new Error('Supabase 未配置');

        var hdrs = {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey,
          'Prefer': 'return=minimal'
        };
        // Update all customers with null/empty account_id to master's account_id
        var patchResp = await fetch(
          supabaseUrl + '/rest/v1/customers?account_id=is.null',
          { method: 'PATCH', headers: hdrs, body: JSON.stringify({ account_id: master.account_id }) }
        );
        var count1 = 0;
        if (patchResp.ok) { count1 = 1; } // best-effort

        // Also handle empty string
        var patchResp2 = await fetch(
          supabaseUrl + '/rest/v1/customers?account_id=eq.',
          { method: 'PATCH', headers: hdrs, body: JSON.stringify({ account_id: master.account_id }) }
        );

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ==================== BHP 拨号器接口与页面并入 ====================

    // Central auth gate: all /api/dialer/ data routes require valid session
    var _dialerAccountId = '';
    if (path.startsWith('/api/dialer/') && !path.startsWith('/api/dialer/auth/') && path !== '/api/dialer/data') {
      var _authHeader = request.headers.get('Authorization') || '';
      var _sessionToken = _authHeader.startsWith('Bearer ') ? _authHeader.slice(7) : '';
      var _session = await dialerValidateSession(env, _sessionToken);
      if (!_session) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      _dialerAccountId = _session.account_id;
      // Master can view sub-account data via X-View-Account-Id header
      var _viewId = request.headers.get('X-View-Account-Id') || '';
      var _isMaster = false;
      if (_viewId) {
        var _accts = await dialerGetAccounts(env);
        for (var _ai = 0; _ai < _accts.length; _ai++) {
          if (_accts[_ai].account_id === _session.account_id && _accts[_ai].is_master !== false) { _isMaster = true; break; }
        }
        if (_isMaster) { _dialerAccountId = _viewId; }
      } else {
        // Master sees all accounts' data when no sub-account view is selected
        var _accts2 = await dialerGetAccounts(env);
        for (var _aj = 0; _aj < _accts2.length; _aj++) {
          if (_accts2[_aj].account_id === _session.account_id && _accts2[_aj].is_master !== false) { _isMaster = true; break; }
        }
        if (_isMaster) { _dialerAccountId = ''; }
      }
    }

    // 1. 获取拨号器数据
    if (path === '/api/dialer/data' && request.method === 'GET') {
      const data = await env.DATA_KV.get('dialer:data');
      return new Response(data || JSON.stringify({ clients: [] }), {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 2. 保存拨号器数据
    if (path === '/api/dialer/data' && request.method === 'POST') {
      try {
        const body = await request.json();
        await env.DATA_KV.put('dialer:data', JSON.stringify(body));
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // 2b. 上传拨号器客户数据到 Supabase
    if (path === '/api/dialer/upload-customers' && request.method === 'POST') {
      try {
        const body = await request.json();
        const customers = body.customers || [];
        const batchLabel = body.batch_label || '';
        const accountId = _dialerAccountId;
        // Add batch_label and account_id to each customer
        const tagged = customers.map(function(c) {
          return Object.assign({}, c, { batch_label: batchLabel, account_id: c.account_id || accountId });
        });
        const sb = createSupabaseClient(env);
        const result = await sb.upsertCustomers(tagged, accountId);
        return new Response(JSON.stringify({ success: true, count: result.count, skipped: result.skipped || 0 }), {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // 2c. 查询 Supabase 客户数据（分页+搜索+排序）
    if (path === '/api/dialer/customers' && request.method === 'GET') {
      try {
        const url = new URL(request.url);
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = parseInt(url.searchParams.get('pageSize') || '50');
        const search = url.searchParams.get('search') || '';
        const sortBy = url.searchParams.get('sortBy') || '';
        const sortDir = url.searchParams.get('sortDir') || 'asc';
        const category = url.searchParams.get('category') || '';
        const batchLabel = url.searchParams.get('batch_label') || '';
        const exclude = url.searchParams.get('exclude') || '';
        const excludeMobiles = exclude ? exclude.split(',').filter(Boolean) : [];
        const accountId = _dialerAccountId;
        const sb = createSupabaseClient(env);
        const result = await sb.getAllCustomers(page, pageSize, search, sortBy, sortDir, category, batchLabel, excludeMobiles, accountId);
        return new Response(JSON.stringify(result), {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ data: [], total: 0, error: e.message }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }
    // "换一批"：按 pulled_at 排序拉取，Supabase 端沉底，多端天然去重
    // Accepts GET (no exclude) or POST with {limit, exclude: string[]}
    if (path === '/api/dialer/customers/random' && (request.method === 'GET' || request.method === 'POST')) {
      try {
        let limit = 50;
        let excludeMobiles = null;

        var accountId = _dialerAccountId;

        if (request.method === 'POST') {
          try {
            const body = await request.json();
            limit = Math.min(parseInt(body.limit) || 50, 200);
            if (Array.isArray(body.exclude) && body.exclude.length > 0) {
              excludeMobiles = body.exclude;
            }
          } catch (parseErr) { /* use defaults */ }
        } else {
          const url = new URL(request.url);
          limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
        }

        // Merge KV-tracked cooldown mobiles into exclude set
        // KV is the RELIABLE fallback — works even when Supabase PATCH fails (RLS, etc.)
        // Each entry auto-expires after 10 days via expirationTtl
        var mergedExclude = (excludeMobiles || []).slice();
        try {
          var cooldownPrefix = 'dialer:cooldown:' + (accountId || '') + ':';
          var cooldownList = await env.DATA_KV.list({ prefix: cooldownPrefix });
          if (cooldownList && cooldownList.keys) {
            for (var ci = 0; ci < cooldownList.keys.length; ci++) {
              var cm = cooldownList.keys[ci].name.replace(cooldownPrefix, '');
              if (cm && mergedExclude.indexOf(cm) === -1) {
                mergedExclude.push(cm);
              }
            }
          }
        } catch (kvErr) { /* KV list may fail, continue without */ }

        const sb = createSupabaseClient(env);

        // Query Supabase with pulled_at ordering:
        // 1. Never pulled first (newest import first)
        // 2. Then oldest-pulled first (natural cycle)
        const result = await sb.getCustomersForDialer(limit, mergedExclude.length > 0 ? mergedExclude : null, accountId);
        const data = result.data || [];
        const total = result.total || 0;

        // Mark just-loaded customers as pulled (sink to bottom for next pull)
        if (data.length > 0) {
          const mobiles = data.map(function(c) { return c.mobile || ''; }).filter(Boolean);

          // 1. Supabase PATCH (best-effort — may fail due to RLS, checked in supabase.js)
          sb.batchSetPulledAt(mobiles, accountId).catch(function() { /* fire-and-forget */ });

          // 2. KV cooldown (RELIABLE guard — always works, auto-expires in 10 days)
          //    This prevents the same batch from cycling back even if PATCH fails.
          for (var mi = 0; mi < mobiles.length; mi++) {
            var ck = 'dialer:cooldown:' + (accountId || '') + ':' + mobiles[mi];
            env.DATA_KV.put(ck, new Date().toISOString(), { expirationTtl: 10 * 24 * 3600 })
              .catch(function() { /* best-effort */ });
          }
        }

        return new Response(JSON.stringify({
          data: data,
          total: total,
          limit: limit
        }), {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ data: [], error: e.message }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2d. 批量更新某个批次的客户分类
    if (path === '/api/dialer/customers/batch-category' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { batch_label, category } = body;
        const accountId = _dialerAccountId;
        if (!batch_label || !category) {
          return new Response(JSON.stringify({ success: false, error: '缺少 batch_label 或 category' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const sb = createSupabaseClient(env);
        const result = await sb.batchUpdateCategory(batch_label, category, accountId);
        return new Response(JSON.stringify({ success: true, updated: result.count }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2d2. 记录客户最新操作时间线
    if (path === '/api/dialer/timeline' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { mobile, entry } = body;
        const accountId = _dialerAccountId;
        if (!mobile || !entry || !entry.type) {
          return new Response(JSON.stringify({ success: false, error: '缺少 mobile 或 entry.type' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const sb = createSupabaseClient(env);
        const result = await sb.updateCustomer(mobile, { last_operation: entry }, accountId);
        return new Response(JSON.stringify({ success: true, data: result }), {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // 2e. 更新单个客户分类标签
    if (path === '/api/dialer/customers' && request.method === 'PATCH') {
      try {
        const body = await request.json();
        const { mobile, fields } = body;
        const accountId = _dialerAccountId;
        const sb = createSupabaseClient(env);
        const updated = await sb.updateCustomer(mobile, fields, accountId);
        return new Response(JSON.stringify({ success: true, data: updated }), {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // 2f. 删除客户/批量删除客户
    if (path === '/api/dialer/customers' && request.method === 'DELETE') {
      try {
        const body = await request.json();
        const { mobile, mobiles } = body;
        const accountId = _dialerAccountId;
        const sb = createSupabaseClient(env);
        if (mobiles && Array.isArray(mobiles)) {
          await sb.deleteCustomers(mobiles, accountId);
          return new Response(JSON.stringify({ success: true, count: mobiles.length }), {
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              'Access-Control-Allow-Origin': '*'
            }
          });
        } else if (mobile) {
          await sb.deleteCustomer(mobile, accountId);
          return new Response(JSON.stringify({ success: true }), {
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              'Access-Control-Allow-Origin': '*'
            }
          });
        } else {
          return new Response(JSON.stringify({ success: false, error: '缺少 mobile 或 mobiles 载荷' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // 2g. 主账户分配客户给子账户
    if (path === '/api/dialer/customers/reassign' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { mobiles, target_account_id } = body;
        if (!mobiles || !Array.isArray(mobiles) || mobiles.length === 0) throw new Error('请选择要分配的客户');
        if (!target_account_id) throw new Error('请选择目标子账户');

        // Verify master
        var _accounts = await dialerGetAccounts(env);
        var _masterFound = false;
        for (var _aj = 0; _aj < _accounts.length; _aj++) {
          if (_accounts[_aj].account_id === _dialerAccountId && _accounts[_aj].is_master !== false) { _masterFound = true; break; }
        }
        if (!_masterFound) throw new Error('仅主账户可分配客户');

        // Verify target exists
        var _targetFound = false;
        for (var _ak = 0; _ak < _accounts.length; _ak++) {
          if (_accounts[_ak].account_id === target_account_id) { _targetFound = true; break; }
        }
        if (!_targetFound) throw new Error('目标子账户不存在');

        const supabaseUrl = env.SUPABASE_URL;
        const supabaseKey = env.SUPABASE_KEY;
        if (!supabaseUrl || !supabaseKey) throw new Error('Supabase 未配置');

        // Batch SELECT + PATCH to handle large selections reliably
        var selBatchSize = 100;
        var existingMobiles = [];
        for (var _sb = 0; _sb < mobiles.length; _sb += selBatchSize) {
          var selChunk = mobiles.slice(_sb, _sb + selBatchSize);
          var selInFilter = selChunk.map(function(m) { return encodeURIComponent(m); }).join(',');
          var checkUrl = supabaseUrl + '/rest/v1/customers?select=mobile&mobile=in.(' + selInFilter + ')&limit=' + selBatchSize;
          var checkResp = await fetch(checkUrl, {
            headers: { 'apikey': supabaseKey, 'Authorization': 'Bearer ' + supabaseKey }
          });
          if (checkResp.ok) {
            var rows = await checkResp.json();
            if (Array.isArray(rows)) {
              for (var _ri = 0; _ri < rows.length; _ri++) {
                existingMobiles.push(rows[_ri].mobile);
              }
            }
          }
        }

        if (existingMobiles.length === 0) throw new Error('所选客户在数据库中不存在');

        // Batch PATCH
        var patchBatchSize = 200;
        var updatedTotal = 0;
        for (var _bi = 0; _bi < existingMobiles.length; _bi += patchBatchSize) {
          var patchChunk = existingMobiles.slice(_bi, _bi + patchBatchSize);
          var patchInFilter = patchChunk.map(function(m) { return encodeURIComponent(m); }).join(',');
          var patchUrl = supabaseUrl + '/rest/v1/customers?mobile=in.(' + patchInFilter + ')';
          var patchResp = await fetch(patchUrl, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseKey,
              'Authorization': 'Bearer ' + supabaseKey,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ account_id: target_account_id, pulled_at: null })
          });
          if (patchResp.ok) updatedTotal += patchChunk.length;
        }

        return new Response(JSON.stringify({
          success: true,
          updated: updatedTotal,
          selected: mobiles.length,
          found: existingMobiles.length
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2h. 存量客户一键迁移至公海客户
    if (path === '/api/dialer/customers/migrate-to-public' && request.method === 'POST') {
      try {
        const supabaseUrl = env.SUPABASE_URL;
        const supabaseKey = env.SUPABASE_KEY;
        if (!supabaseUrl || !supabaseKey) {
          throw new Error('Supabase URL or Key is not configured');
        }
        const hdrs = {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey
        };
        // Update all customers where category is null or not equal to '公海客户'
        const patchResp = await fetch(
          supabaseUrl + '/rest/v1/customers?or=(category.is.null,category.not.eq.%E5%85%AC%E6%B5%B7%E5%AE%A2%E6%88%B7)',
          {
            method: 'PATCH',
            headers: hdrs,
            body: JSON.stringify({ category: '公海客户' })
          }
        );
        if (!patchResp.ok) {
          const errMsg = await patchResp.text();
          throw new Error('Supabase bulk update failed: ' + errMsg);
        }
        return new Response(JSON.stringify({ success: true, message: '存量客户已全部迁移至公海' }), {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // 2e. 调试：查看 Supabase 表结构
    if (path === '/api/debug/schema' && request.method === 'GET') {
      try {
        const sb = createSupabaseClient(env);
        // Fetch customers table schema via PostgREST
        const resp = await fetch(env.SUPABASE_URL + '/rest/v1/', {
          headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': 'Bearer ' + env.SUPABASE_KEY
          }
        });
        const openApi = await resp.text();
        // Try to query a few rows to see actual column names
        let sampleData = null;
        try {
          const sampleResp = await fetch(env.SUPABASE_URL + '/rest/v1/customers?limit=1', {
            headers: {
              'apikey': env.SUPABASE_KEY,
              'Authorization': 'Bearer ' + env.SUPABASE_KEY
            }
          });
          sampleData = await sampleResp.json();
        } catch(e) {
          sampleData = { error: e.message };
        }
        return new Response(JSON.stringify({
          openapi_preview: openApi.slice(0, 3000),
          sample_customers: sampleData,
          customers_row_count: Array.isArray(sampleData) ? sampleData.length : 0
        }, null, 2), {
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2f-0. 管理员：IP 黑名单管理
    if (path === '/api/admin/blocked-ips') {
      // 验证管理密码
      const adminPwd = await env.DATA_KV.get('config:db_password');
      if (!adminPwd) {
        return new Response(JSON.stringify({ error: 'Admin password not configured in KV' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const reqKey = request.headers.get('x-admin-key');
      const urlKey = url.searchParams.get('key');
      const authKey = reqKey || urlKey || '';
      if (authKey !== adminPwd) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      }

      try {
        if (request.method === 'GET') {
          const list = await listBlockedIPs(env);
          return new Response(JSON.stringify({ blocked: list, count: list.length }), {
            headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
          });
        }
        if (request.method === 'DELETE') {
          const body = await request.json().catch(() => ({}));
          const targetIP = body.ip || url.searchParams.get('ip');
          if (!targetIP) {
            return new Response(JSON.stringify({ error: 'Missing ip parameter' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
            });
          }
          await unblockIP(env, targetIP);
          return new Response(JSON.stringify({ success: true, unblocked: targetIP }), {
            headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
          });
        }
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2f. 管理员：迁移公公积金并清理测试数据
    if (path === '/api/admin/migrate-fund' && request.method === 'GET') {
      try {
        const supabaseUrl = env.SUPABASE_URL;
        const supabaseKey = env.SUPABASE_KEY;
        if (!supabaseUrl || !supabaseKey) {
          throw new Error('Supabase URL or Key is not configured');
        }
        const hdrs = {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey
        };

        // 1. 删除测试数据
        // 匹配 name 包含 "测试"，或者 batch_label 等于 "测试批次" 或 "重入测试"
        const delResp = await fetch(
          supabaseUrl + '/rest/v1/customers?or=name.ilike.%25%E6%B5%8B%E8%AF%95%25,batch_label.eq.%E6%B5%8B%E8%AF%95%E6%89%B9%E6%AC%A1,batch_label.eq.%E9%87%8D%E5%85%A5%E6%B5%8B%E8%AF%95',
          { method: 'DELETE', headers: hdrs }
        );
        let delResult = 'OK';
        if (!delResp.ok) {
          delResult = await delResp.text();
        }

        // 2. 循环拉取所有剩余客户
        var all = [];
        var pageNum = 0;
        var pageSizeNum = 1000;
        while (true) {
          var fromVal = pageNum * pageSizeNum;
          var toVal = fromVal + pageSizeNum - 1;
          var qResp = await fetch(
            supabaseUrl + '/rest/v1/customers?select=*',
            { headers: Object.assign({}, hdrs, { 'Range': fromVal + '-' + toVal }) }
          );
          if (!qResp.ok) break;
          var dataList = await qResp.json();
          if (!Array.isArray(dataList) || dataList.length === 0) break;
          all.push.apply(all, dataList);
          if (dataList.length < pageSizeNum) break;
          pageNum++;
        }

        // 3. 筛选并执行公积金数据迁移（提取备注里的纯数字，嵌入 note JSON）
        let migratedCount = 0;
        let updatePromises = [];
        // 辅助: 构建 note JSON（fund 嵌入其中）
        function buildMigrateNoteJSON(rawNote, fundVal) {
          var obj = { note: '', custom: {} };
          if (rawNote && rawNote.indexOf('{') === 0) {
            try { var p = JSON.parse(rawNote); if (p && typeof p === 'object') obj = p; } catch(e) {}
          } else if (rawNote) {
            obj.note = rawNote;
          }
          if (fundVal) { obj.fund = fundVal; } else { delete obj.fund; }
          if (!obj.fund && Object.keys(obj.custom || {}).length === 0 && obj.note && obj.note.indexOf('{') !== 0) {
            return obj.note;
          }
          return JSON.stringify(obj);
        }
        for (var i = 0; i < all.length; i++) {
          var c = all[i];
          var noteVal = (c.note || '').trim();
          // 提取 note 中的纯文本（如果是 JSON）
          var plainNote = noteVal;
          if (noteVal.indexOf('{') === 0) {
            try { var np = JSON.parse(noteVal); plainNote = (np.note || '').trim(); } catch(e) {}
          }
          // 匹配 4 位数或 5 位数纯数字作为公积金（如 19580, 8450）
          var match = plainNote.match(/\b\d{4,5}\b/);
          if (match) {
            var fundVal = match[0];
            var newPlainNote = plainNote.replace(fundVal, '').trim();
            if (/^[，。,.\-\s]*$/.test(newPlainNote)) {
              newPlainNote = '';
            }

            migratedCount++;
            var newNotePayload = buildMigrateNoteJSON(noteVal, fundVal);
            // 如果有纯文本备注内容，覆盖进 JSON
            if (newPlainNote && newNotePayload.indexOf('{') === 0) {
              try { var tmp = JSON.parse(newNotePayload); tmp.note = newPlainNote; newNotePayload = JSON.stringify(tmp); } catch(e) {}
            }
            const updateFields = { note: newNotePayload };
            
            // 发送 PATCH 请求更新每一条记录
            updatePromises.push((async (mob, fields) => {
              try {
                const patchResp = await fetch(
                  supabaseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(mob),
                  {
                    method: 'PATCH',
                    headers: Object.assign({}, hdrs, { 'Prefer': 'return=minimal' }),
                    body: JSON.stringify(fields)
                  }
                );
                return patchResp.ok;
              } catch(errPatch) {
                return false;
              }
            })(c.mobile, updateFields));
          }
        }

        const results = await Promise.all(updatePromises);
        const successCount = results.filter(Boolean).length;

        return new Response(JSON.stringify({
          success: true,
          deleted_test_data: delResult,
          total_customers_found: all.length,
          matching_note_records: migratedCount,
          successfully_migrated: successCount
        }), {
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 共享函数：AI 修正公积金，供 HTTP 和定时任务复用
    async function runAICorrectFund(env) {
      const supabaseUrl = env.SUPABASE_URL;
      const supabaseKey = env.SUPABASE_KEY;
      if (!supabaseUrl || !supabaseKey) {
        return { success: false, error: 'Supabase URL or Key is not configured' };
      }
      const hdrs = {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey
      };

      // 辅助: 构建 {note, custom, fund} JSON，fund 非空时嵌入
      function buildFundNoteJSON(noteText, fundVal) {
        var obj = { note: '', custom: {} };
        // 尝试解析已有 JSON note
        if (noteText && noteText.indexOf('{') === 0) {
          try { var parsed = JSON.parse(noteText); if (parsed && typeof parsed === 'object') obj = parsed; } catch(e) {}
        } else if (noteText) {
          obj.note = noteText;
        }
        if (fundVal) { obj.fund = fundVal; } else { delete obj.fund; }
        // 兜底：note 为纯文本且无其他字段时，不套 JSON
        if (!obj.fund && Object.keys(obj.custom || {}).length === 0 && obj.note && obj.note.indexOf('{') !== 0) {
          return obj.note;
        }
        return JSON.stringify(obj);
      }

      // 1. 分页拉取所有客户
      var all = [];
      var pageNum = 0;
      var pageSizeNum = 1000;
      while (true) {
        var fromVal = pageNum * pageSizeNum;
        var toVal = fromVal + pageSizeNum - 1;
        var qResp = await fetch(
          supabaseUrl + '/rest/v1/customers?select=*',
          { headers: Object.assign({}, hdrs, { 'Range': fromVal + '-' + toVal }) }
        );
        if (!qResp.ok) break;
        var dataList = await qResp.json();
        if (!Array.isArray(dataList) || dataList.length === 0) break;
        all.push.apply(all, dataList);
        if (dataList.length < pageSizeNum) break;
        pageNum++;
      }

      // 2. 筛选可疑行
      var suspiciousRows = [];
      for (var i = 0; i < all.length; i++) {
        var c = all[i];
        var fundVal = (c.fund || '').trim();
        var companyVal = (c.company_name || '').trim();
        var noteRaw = (c.note || '').trim();
        var noteText = noteRaw;
        if (noteRaw.indexOf('{') === 0) {
          try {
            var noteObj = JSON.parse(noteRaw);
            noteText = (noteObj.note || '').trim();
          } catch(e) { noteText = noteRaw; }
        }
        var isFundSuspicious = fundVal && !/^\d{4,5}$/.test(fundVal);
        var isCompanySuspicious = companyVal && /^\d{4,5}$/.test(companyVal);
        var isNoteSuspicious = !companyVal && noteText && noteText.length <= 80 && /[一-龥]/.test(noteText) && !/已联系|已拨打|未接|关机|空号|停机|加微信|意向|跟进|备注/.test(noteText);
        var noteNumMatch = noteText.match(/\b(\d{1,5})\b/g);
        var isNoteHasFundNumber = false;
        if (noteNumMatch && !fundVal) {
          for (var nm = 0; nm < noteNumMatch.length; nm++) {
            var n = parseInt(noteNumMatch[nm], 10);
            if (n >= 1 && n <= 49999) { isNoteHasFundNumber = true; break; }
          }
        }
        if (isFundSuspicious || isCompanySuspicious || isNoteSuspicious || isNoteHasFundNumber) {
          suspiciousRows.push({
            mobile: c.mobile,
            fund: fundVal,
            company_name: companyVal,
            note: noteText
          });
        }
      }

      if (suspiciousRows.length === 0) {
        return {
          success: true,
          total_scanned: all.length,
          suspicious_found: 0,
          ai_corrected: 0,
          corrections: [],
          errors: [],
          message: '没有发现需要修正的数据，fund、company_name 和 note 字段均正常。'
        };
      }

      // 3. 批量发送给 AI 判断 (每批最多 20 条)
      var BATCH_SIZE = 20;
      var corrected = 0;
      var corrections = [];
      var errors = [];

      for (var batchStart = 0; batchStart < suspiciousRows.length; batchStart += BATCH_SIZE) {
        var batch = suspiciousRows.slice(batchStart, batchStart + BATCH_SIZE);
        var promptRows = batch.map(function(r, idx) {
          return '  [' + (batchStart + idx) + '] mobile=' + r.mobile + ', fund="' + r.fund + '", company_name="' + r.company_name + '", note="' + (r.note || '') + '"';
        }).join('\n');

        var prompt = (
          '你是一个数据清洗助手。检查以下每条客户记录，判断 fund（公积金）、company_name（单位名称）、note（备注）字段是否存错了位置。\n\n' +
          '规则：\n' +
          '1. 如果 fund 存的是单位名称（公司/学校/机构等，含中文组织名）→ 应移到 company_name。输出: {"action": "move_fund_to_company"}\n' +
          '2. 如果 company_name 存的是纯数字 4-5 位（公积金账号）→ 应移到 fund。输出: {"action": "move_company_to_fund"}\n' +
          '3. 如果 fund 存单位名 且 company_name 存数字 → 两者互换。输出: {"action": "swap"}\n' +
          '4. 如果 note 存的是单位名称（company_name 为空时）→ 应移到 company_name。输出: {"action": "move_note_to_company"}\n' +
          '5. 如果 fund 是乱码/备注/无意义文字（不是单位名也不是数字）→ 清空 fund。输出: {"action": "clear_fund"}\n' +
          '6. 如果 note（备注）中包含阿拉伯数字且在 1-49999 之间（如 8000、15000），且 fund 为空 → 应将数字移到 fund。输出: {"action": "move_note_number_to_fund", "fund_value": "<数字>"}\n' +
          '7. 如果不确定 → 跳过。输出: {"action": "skip"}\n\n' +
          '注意：\n' +
          '- 单位名包括：公司（腾讯科技）、学校（实验小学、某某幼儿园/小学/中学/大学）、机构（建设银行、人民医院）\n' +
          '- 备注里只有确信是单位名称时才建议 move_note_to_company\n' +
          '- 如果备注是普通的跟进记录（"已联系"等）请不要移动\n' +
          '- 公积金数字通常单独出现（如"公积金8000"、"余额15000"），不要提取电话号码中的数字\n' +
          '- 只在确定的情况下才建议修正，不确定就 skip\n\n' +
          '请对以下每条记录分析，只输出 JSON 数组：\n' +
          '[\n' +
          '  {"idx": 序号, "action": "move_fund_to_company|move_company_to_fund|swap|move_note_to_company|clear_fund|move_note_number_to_fund|skip"},\n' +
          '  ...\n' +
          ']\n\n' +
          '输入数据：\n' + promptRows
        );

        try {
          var apiData = await callAIChat(env, [
            { role: 'system', content: '你是一个严谨的数据清洗助手。请严格按 JSON 格式输出。' },
            { role: 'user', content: prompt }
          ], 0.1);

          var aiContent = apiData.choices[0].message.content.trim();
          if (aiContent.startsWith('```')) {
            aiContent = aiContent.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
          }

          var decisions;
          try { decisions = JSON.parse(aiContent); }
          catch (parseErr) { errors.push('Batch ' + Math.floor(batchStart / BATCH_SIZE) + ': AI JSON parse error: ' + parseErr.message); continue; }
          if (!Array.isArray(decisions)) { errors.push('Batch ' + Math.floor(batchStart / BATCH_SIZE) + ': AI returned non-array'); continue; }

          for (var d = 0; d < decisions.length; d++) {
            var dec = decisions[d];
            var rowIdx = dec.idx;
            var originalRow = null;
            for (var s = 0; s < batch.length; s++) {
              if ((batchStart + s) === rowIdx) { originalRow = batch[s]; break; }
            }
            if (!originalRow) { errors.push('idx ' + rowIdx + ' not found in batch'); continue; }

            if (dec.action === 'move_fund_to_company') {
              // fund 存的是公司名 → 移到 company_name（fund 值在 note JSON 里，这里只设 company_name）
              if (!originalRow.fund) { errors.push('row ' + rowIdx + ' move_fund_to_company missing value'); continue; }
              try {
                var r1 = await fetch(supabaseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(originalRow.mobile),
                  { method: 'PATCH', headers: Object.assign({}, hdrs, { 'Prefer': 'return=minimal' }), body: JSON.stringify({ company_name: originalRow.fund }) });
                if (r1.ok) { corrected++; corrections.push({ mobile: originalRow.mobile, action: 'move_fund_to_company', old_fund: originalRow.fund, new_company_name: originalRow.fund }); }
                else { var e1 = await r1.text(); errors.push('PATCH ' + originalRow.mobile + ': ' + e1); }
              } catch (pe) { errors.push('PATCH err ' + originalRow.mobile + ': ' + pe.message); }
            } else if (dec.action === 'move_company_to_fund') {
              // company_name 存的是公积金数字 → 嵌入 note JSON，清空 company_name
              if (!originalRow.company_name) { errors.push('row ' + rowIdx + ' move_company_to_fund missing value'); continue; }
              try {
                var noteJson2 = buildFundNoteJSON(originalRow.note, originalRow.company_name);
                var r2 = await fetch(supabaseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(originalRow.mobile),
                  { method: 'PATCH', headers: Object.assign({}, hdrs, { 'Prefer': 'return=minimal' }), body: JSON.stringify({ company_name: '', note: noteJson2 }) });
                if (r2.ok) { corrected++; corrections.push({ mobile: originalRow.mobile, action: 'move_company_to_fund', old_company_name: originalRow.company_name, new_fund: originalRow.company_name }); }
                else { var e2 = await r2.text(); errors.push('PATCH ' + originalRow.mobile + ': ' + e2); }
              } catch (pe) { errors.push('PATCH err ' + originalRow.mobile + ': ' + pe.message); }
            } else if (dec.action === 'swap') {
              // fund 和 company_name 互换（fund 嵌入 note JSON）
              try {
                var noteJson3 = buildFundNoteJSON(originalRow.note, originalRow.company_name);
                var r3 = await fetch(supabaseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(originalRow.mobile),
                  { method: 'PATCH', headers: Object.assign({}, hdrs, { 'Prefer': 'return=minimal' }), body: JSON.stringify({ company_name: originalRow.fund, note: noteJson3 }) });
                if (r3.ok) { corrected++; corrections.push({ mobile: originalRow.mobile, action: 'swap', old_fund: originalRow.fund, old_company_name: originalRow.company_name }); }
                else { var e3 = await r3.text(); errors.push('PATCH swap ' + originalRow.mobile + ': ' + e3); }
              } catch (pe) { errors.push('PATCH swap err ' + originalRow.mobile + ': ' + pe.message); }
            } else if (dec.action === 'move_note_to_company') {
              if (!originalRow.note) { errors.push('row ' + rowIdx + ' move_note_to_company missing value'); continue; }
              try {
                var r4 = await fetch(supabaseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(originalRow.mobile),
                  { method: 'PATCH', headers: Object.assign({}, hdrs, { 'Prefer': 'return=minimal' }), body: JSON.stringify({ note: '', company_name: originalRow.note }) });
                if (r4.ok) { corrected++; corrections.push({ mobile: originalRow.mobile, action: 'move_note_to_company', old_note: originalRow.note, new_company_name: originalRow.note }); }
                else { var e4 = await r4.text(); errors.push('PATCH note ' + originalRow.mobile + ': ' + e4); }
              } catch (pe) { errors.push('PATCH note err ' + originalRow.mobile + ': ' + pe.message); }
            } else if (dec.action === 'clear_fund') {
              // 清空 fund：从 note JSON 中移除 fund
              try {
                var noteJson5 = buildFundNoteJSON(originalRow.note, '');
                var r5 = await fetch(supabaseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(originalRow.mobile),
                  { method: 'PATCH', headers: Object.assign({}, hdrs, { 'Prefer': 'return=minimal' }), body: JSON.stringify({ note: noteJson5 }) });
                if (r5.ok) { corrected++; corrections.push({ mobile: originalRow.mobile, action: 'clear_fund', old_fund: originalRow.fund }); }
                else { var e5 = await r5.text(); errors.push('PATCH clear_fund ' + originalRow.mobile + ': ' + e5); }
              } catch (pe) { errors.push('PATCH clear_fund err ' + originalRow.mobile + ': ' + pe.message); }
            } else if (dec.action === 'move_note_number_to_fund') {
              var fundNum = dec.fund_value || '';
              if (!fundNum) { var autoMatch = originalRow.note.match(/\b(\d{1,5})\b/); if (autoMatch) fundNum = autoMatch[1]; }
              if (!fundNum) { errors.push('row ' + rowIdx + ' move_note_number_to_fund missing fund_value'); continue; }
              var newNoteText = originalRow.note.replace(new RegExp('\\b' + fundNum + '\\b'), '').trim();
              newNoteText = newNoteText.replace(/^[，。,.\-\s]+/, '').replace(/[，。,.\-\s]+$/, '').trim();
              if (!newNoteText) newNoteText = '';
              try {
                var noteJson6 = buildFundNoteJSON(newNoteText, fundNum);
                var r6 = await fetch(supabaseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(originalRow.mobile),
                  { method: 'PATCH', headers: Object.assign({}, hdrs, { 'Prefer': 'return=minimal' }), body: JSON.stringify({ note: noteJson6 }) });
                if (r6.ok) { corrected++; corrections.push({ mobile: originalRow.mobile, action: 'move_note_number_to_fund', fund_value: fundNum, old_note: originalRow.note, new_note: noteJson6 }); }
                else { var e6 = await r6.text(); errors.push('PATCH move_note_number_to_fund ' + originalRow.mobile + ': ' + e6); }
              } catch (pe) { errors.push('PATCH move_note_number_to_fund err ' + originalRow.mobile + ': ' + pe.message); }
            }
          }
        } catch (aiErr) {
          errors.push('Batch ' + Math.floor(batchStart / BATCH_SIZE) + ' AI error: ' + aiErr.message);
        }
      }

      return {
        success: true,
        total_scanned: all.length,
        suspicious_found: suspiciousRows.length,
        ai_corrected: corrected,
        corrections: corrections,
        errors: errors,
        message: '修正完成。扫描 ' + all.length + ' 条，发现 ' + suspiciousRows.length + ' 条可疑，AI 已修正 ' + corrected + ' 条。'
      };
    }

    // 2h. AI: 修正公积金字段（可手动触发或定时任务自动调用）
    if (path === '/api/admin/ai-correct-fund' && request.method === 'GET') {
      try {
        const result = await runAICorrectFund(env);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' },
          status: result.success ? 200 : 500
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 3. 代理 SheetJS 资源以加快文件解析加载
    if (path === '/xlsx.full.min.js') {
      return fetch('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    }


    if (path.startsWith('/tessdata/')) {
      const fileName = path.replace('/tessdata/', '');
      
      if (fileName === 'worker.min.js') {
        const cacheKey = `tessdata:${fileName}`;
        let fileData = null;
        if (env.DATA_KV) {
          fileData = await env.DATA_KV.get(cacheKey, { type: 'arrayBuffer' });
        }
        if (!fileData) {
          const cdnUrl = 'https://fastly.jsdelivr.net/npm/tesseract.js@4.1.1/dist/worker.min.js';
          const response = await fetch(cdnUrl);
          if (response.ok) {
            const buffer = await response.arrayBuffer();
            if (env.DATA_KV) {
              await env.DATA_KV.put(cacheKey, buffer);
            }
            fileData = buffer;
          } else {
            return new Response('Failed to fetch worker from CDN: ' + response.status, {
              status: 502,
              headers: { 'Access-Control-Allow-Origin': '*' }
            });
          }
        }
        return new Response(fileData, {
          headers: {
            'Content-Type': 'application/javascript',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000'
          }
        });
      }

      if (fileName.startsWith('core/')) {
        const coreFile = fileName.replace('core/', '');
        const cacheKey = `tessdata:core:${coreFile}`;
        let fileData = null;
        if (env.DATA_KV) {
          fileData = await env.DATA_KV.get(cacheKey, { type: 'arrayBuffer' });
        }
        if (!fileData) {
          const cdnUrl = `https://fastly.jsdelivr.net/npm/tesseract.js-core@4.0.2/${coreFile}`;
          const response = await fetch(cdnUrl);
          if (response.ok) {
            const buffer = await response.arrayBuffer();
            if (env.DATA_KV) {
              await env.DATA_KV.put(cacheKey, buffer);
            }
            fileData = buffer;
          } else {
            return new Response('Failed to fetch core from CDN: ' + response.status, {
              status: 502,
              headers: { 'Access-Control-Allow-Origin': '*' }
            });
          }
        }
        let contentType = 'application/octet-stream';
        if (coreFile.endsWith('.js')) {
          contentType = 'application/javascript';
        } else if (coreFile.endsWith('.wasm')) {
          contentType = 'application/wasm';
        }
        return new Response(fileData, {
          headers: {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000'
          }
        });
      }

      if (fileName.endsWith('.traineddata.gz')) {
        const cacheKey = `tessdata:${fileName}`;
        let fileData = null;
        if (env.DATA_KV) {
          fileData = await env.DATA_KV.get(cacheKey, { type: 'arrayBuffer' });
        }
        
        if (!fileData) {
          const cdnUrl = `https://fastly.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_fast/${fileName}`;
          const response = await fetch(cdnUrl);
          if (response.ok) {
            const buffer = await response.arrayBuffer();
            if (env.DATA_KV) {
              await env.DATA_KV.put(cacheKey, buffer);
            }
            fileData = buffer;
          } else {
            return new Response('Failed to fetch from CDN: ' + response.status, {
              status: 502,
              headers: { 'Access-Control-Allow-Origin': '*' }
            });
          }
        }
        
        return new Response(fileData, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000'
          }
        });
      }
    }

    // 4. 服务 PWA manifest
    if (path === '/manifest.json') {
      const manifest = {
        name: '生活记事录',
        short_name: '生活记事录',
        description: '生活记事录：日常记录与追踪',
        start_url: '/',
        display: 'standalone',
        background_color: '#ededed',
        theme_color: '#34D399',
        orientation: 'portrait',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      };
      return new Response(JSON.stringify(manifest), {
        headers: { 'Content-Type': 'application/manifest+json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 5. 服务 App 图标 SVG (二次元风格)
    if (path === '/icon.svg') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f9a8d4"/><stop offset="50%" stop-color="#c4b5fd"/><stop offset="100%" stop-color="#93c5fd"/></linearGradient><linearGradient id="hair" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#4a5568"/><stop offset="100%" stop-color="#2d3748"/></linearGradient></defs><rect width="512" height="512" rx="120" fill="url(#bg)"/><ellipse cx="256" cy="210" rx="75" ry="55" fill="#fce4ec" opacity="0.6"/><ellipse cx="220" cy="195" rx="42" ry="50" fill="url(#hair)"/><ellipse cx="292" cy="195" rx="42" ry="50" fill="url(#hair)"/><circle cx="256" cy="185" r="70" fill="#fce4ec"/><ellipse cx="256" cy="205" rx="52" ry="44" fill="#fff5f5"/><ellipse cx="238" cy="218" rx="12" ry="16" fill="#1a202c"/><ellipse cx="274" cy="218" rx="12" ry="16" fill="#1a202c"/><circle cx="242" cy="213" r="4" fill="white"/><circle cx="278" cy="213" r="4" fill="white"/><ellipse cx="238" cy="222" rx="3" ry="5" fill="white" opacity="0.6"/><ellipse cx="274" cy="222" rx="3" ry="5" fill="white" opacity="0.6"/><ellipse cx="256" cy="236" rx="8" ry="5" fill="#f8a0a0"/><path d="M 246 250 Q 256 262 266 250" stroke="#e08080" stroke-width="3" fill="none" stroke-linecap="round"/><ellipse cx="220" cy="170" rx="35" ry="40" fill="url(#hair)" transform="rotate(-15,220,170)"/><ellipse cx="292" cy="170" rx="35" ry="40" fill="url(#hair)" transform="rotate(15,292,170)"/><ellipse cx="256" cy="155" rx="58" ry="38" fill="url(#hair)"/><circle cx="180" cy="330" r="6" fill="#fce4ec"/><circle cx="340" cy="280" r="4" fill="#fce4ec"/><circle cx="350" cy="360" r="5" fill="#fce4ec"/><circle cx="160" cy="260" r="3" fill="#fce4ec"/><path d="M 290 320 L 296 314 L 302 320 L 296 326 Z" fill="#fbbf24"/><circle cx="296" cy="320" r="12" fill="none" stroke="#fbbf24" stroke-width="3" stroke-dasharray="6,4"/><rect x="118" y="360" width="276" height="46" rx="23" fill="white" opacity="0.85"/><text x="256" y="392" text-anchor="middle" font-family="system-ui,sans-serif" font-size="28" font-weight="900" fill="#7c3aed">生活记事录</text></svg>`;
      return new Response(svg, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 6. favicon.ico 兼容
    if (path === '/favicon.ico') {
      const svg2 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f9a8d4"/><stop offset="50%" stop-color="#c4b5fd"/><stop offset="100%" stop-color="#93c5fd"/></linearGradient><linearGradient id="hair" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#4a5568"/><stop offset="100%" stop-color="#2d3748"/></linearGradient></defs><rect width="512" height="512" rx="120" fill="url(#bg)"/><circle cx="256" cy="185" r="70" fill="#fce4ec"/><ellipse cx="256" cy="205" rx="52" ry="44" fill="#fff5f5"/><ellipse cx="238" cy="218" rx="12" ry="16" fill="#1a202c"/><ellipse cx="274" cy="218" rx="12" ry="16" fill="#1a202c"/><circle cx="242" cy="213" r="4" fill="white"/><circle cx="278" cy="213" r="4" fill="white"/><ellipse cx="256" cy="236" rx="8" ry="5" fill="#f8a0a0"/><path d="M 246 250 Q 256 262 266 250" stroke="#e08080" stroke-width="3" fill="none" stroke-linecap="round"/><ellipse cx="220" cy="170" rx="35" ry="40" fill="url(#hair)" transform="rotate(-15,220,170)"/><ellipse cx="292" cy="170" rx="35" ry="40" fill="url(#hair)" transform="rotate(15,292,170)"/><ellipse cx="256" cy="155" rx="58" ry="38" fill="url(#hair)"/><path d="M 290 320 L 296 314 L 302 320 L 296 326 Z" fill="#fbbf24"/><circle cx="296" cy="320" r="12" fill="none" stroke="#fbbf24" stroke-width="3" stroke-dasharray="6,4"/><rect x="118" y="360" width="276" height="46" rx="23" fill="white" opacity="0.85"/><text x="256" y="392" text-anchor="middle" font-family="system-ui,sans-serif" font-size="28" font-weight="900" fill="#7c3aed">记事录</text></svg>`;
      return new Response(svg2, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // ==================== API 接口 ====================
    
    // 获取数据
    if (path === '/api/data' && request.method === 'GET') {
      const date = url.searchParams.get('date');
      if (!date) {
        return new Response(JSON.stringify({ error: '缺少 date 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const rawData = await env.DATA_KV.get(`work:${date}`);
      const data = rawData ? JSON.parse(rawData) : {
        date,
        wechatCount: 0,
        intentCount: 0,
        revisitCount: 0,
        visitCount: 0,
        paymentCount: 0,
        clients: [],
        todayTodos: [],
        tomorrowTodos: [],
        tempClients: [],
        lastLoadDate: date
      };
      if (!data.lastLoadDate) data.lastLoadDate = date;
      if (!data.tempClients) data.tempClients = [];
      if (data.visitCount === undefined) data.visitCount = 0;
      if (data.paymentCount === undefined) data.paymentCount = 0;
      // Inject global webhook URL so it persists across all dates and new days
      data.webhookUrl = await env.DATA_KV.get('config:webhook_url') || '';
      data.pinHash = await env.DATA_KV.get('config:pin_hash') || '';
      data.deepseekApiKey = await env.DATA_KV.get('config:deepseek_api_key') || '';
      data.aiApiKey = await env.DATA_KV.get('config:ai_api_key') || '';
      data.aiApiBase = await env.DATA_KV.get('config:ai_api_base') || '';
      data.aiModel = await env.DATA_KV.get('config:ai_model') || '';
      data.visionApiBase = await env.DATA_KV.get('config:vision_api_base') || '';
      // Inject goals
      data.goals = JSON.parse(await env.DATA_KV.get('config:goals') || '{}');
      // Inject journal
      data.journal = JSON.parse(await env.DATA_KV.get('journal:' + date) || '[]');
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 保存数据（服务端合并，解决多设备同步冲突）
    if (path === '/api/data' && request.method === 'POST') {
      const body = await request.json();
      const items = Array.isArray(body) ? body : [body];
      let hasError = false;
      for (const item of items) {
        const { date, wechatCount, intentCount, revisitCount, visitCount, paymentCount, clients, todayTodos, tomorrowTodos, tempClients, scripts, learns, todoLog, webhookUrl, deepseekApiKey, aiProvider, aiApiKey, aiApiBase, aiModel, visionApiKey, visionApiBase, _ts } = item;
        if (!date) { hasError = true; continue; }
        
        // If a non-empty Webhook URL is supplied, persist it globally
        if (webhookUrl) {
          await env.DATA_KV.put('config:webhook_url', webhookUrl);
        }
        if (deepseekApiKey !== undefined) {
          await env.DATA_KV.put('config:deepseek_api_key', deepseekApiKey);
        }
        if (aiProvider !== undefined) {
          await env.DATA_KV.put('config:ai_provider', aiProvider);
        }
        if (aiApiKey !== undefined) {
          await env.DATA_KV.put('config:ai_api_key', aiApiKey);
        }
        if (aiApiBase !== undefined) {
          await env.DATA_KV.put('config:ai_api_base', aiApiBase);
        }
        if (aiModel !== undefined) {
          await env.DATA_KV.put('config:ai_model', aiModel);
        }
        if (visionApiKey !== undefined) {
          await env.DATA_KV.put('config:vision_api_key', visionApiKey);
        }
        if (visionApiBase !== undefined) {
          await env.DATA_KV.put('config:vision_api_base', visionApiBase);
        }

        // 读取云端现有数据
        const rawExisting = await env.DATA_KV.get(`work:${date}`);
        const existing = rawExisting ? JSON.parse(rawExisting) : {};
        // 客户列表按 phone 号码唯一性合并（同一电话号码只保留最新记录）
        // incoming 中的客户记录会覆盖 base 中相同电话号码 of 旧记录
        const mergeClients = (base, incoming) => {
          const map = new Map();
          (base || []).forEach(c => map.set(c.phone, c));
          (incoming || []).forEach(c => map.set(c.phone, c));
          return [...map.values()];
        };
        const mergedClients = mergeClients(existing.clients, clients);
        const merged = {
          date,
          wechatCount: Math.max(existing.wechatCount || 0, wechatCount || 0),
          intentCount: mergedClients.length,
          revisitCount: Math.max(existing.revisitCount || 0, revisitCount || 0),
          visitCount: Math.max(existing.visitCount || 0, visitCount || 0),
          paymentCount: Math.max(existing.paymentCount || 0, paymentCount || 0),
          clients: mergedClients,
          todayTodos: todayTodos || existing.todayTodos || [],
          tomorrowTodos: tomorrowTodos || existing.tomorrowTodos || [],
          tempClients: tempClients !== undefined
            ? (tempClients || []).filter(tc => !tc.date || tc.date === date)
            : (existing.tempClients || []),
          scripts: scripts || existing.scripts || [],
          learns: learns || existing.learns || [],
          todoLog: todoLog || existing.todoLog || [],
          webhookUrl: webhookUrl || existing.webhookUrl || '',
          deepseekApiKey: deepseekApiKey !== undefined ? deepseekApiKey : (existing.deepseekApiKey || ''),
          aiApiKey: aiApiKey !== undefined ? aiApiKey : (existing.aiApiKey || ''),
          aiApiBase: aiApiBase !== undefined ? aiApiBase : (existing.aiApiBase || ''),
          aiModel: aiModel !== undefined ? aiModel : (existing.aiModel || ''),
          visionApiBase: visionApiBase !== undefined ? visionApiBase : (existing.visionApiBase || ''),
          lastLoadDate: date,
          lastModified: new Date().toISOString(),
          _ts: _ts || Date.now()
        };
        await env.DATA_KV.put(`work:${date}`, JSON.stringify(merged));
      }
      if (items.length === 0 || (hasError && items.length === 1)) {
        return new Response(JSON.stringify({ error: '缺少 date 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 原子操作同步 —— 每个增删改作为独立 delta 推送到 KV，保证最快同步
    if (path === '/api/sync' && request.method === 'POST') {
      const body = await request.json();
      const { date, op } = body;
      if (!date || !op) {
        return new Response(JSON.stringify({ error: '缺少 date 或 op 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const raw = await env.DATA_KV.get(`work:${date}`);
      const data = raw ? JSON.parse(raw) : {
        date, wechatCount: 0, intentCount: 0, revisitCount: 0, visitCount: 0, paymentCount: 0, clients: [],
        todayTodos: [], tomorrowTodos: [], tempClients: [], scripts: [], learns: [], todoLog: []
      };
      if (!data.tempClients) data.tempClients = [];
      const ts = Date.now();
      switch (op) {
        case 'incWechat': {
          const delta = body.delta || 0;
          data.wechatCount = Math.max((data.wechatCount || 0) + delta, 0);
          break;
        }
        case 'incRevisit': {
          const delta = body.delta || 0;
          data.revisitCount = Math.max((data.revisitCount || 0) + delta, 0);
          break;
        }
        case 'incVisit': {
          const delta = body.delta || 0;
          data.visitCount = Math.max((data.visitCount || 0) + delta, 0);
          break;
        }
        case 'incPayment': {
          const delta = body.delta || 0;
          data.paymentCount = Math.max((data.paymentCount || 0) + delta, 0);
          break;
        }
        case 'addClient': {
          if (body.client) {
            data.clients = [...(data.clients || []), body.client];
            data.intentCount = data.clients.length;
          }
          break;
        }
        // DEPRECATED: Use removeClientByMatch instead to avoid index mismatch on multi-device concurrent deletes
        case 'removeClientByIndex': {
          if (body.index !== undefined && body.index >= 0) {
            data.clients = data.clients || [];
            data.clients.splice(body.index, 1);
            data.intentCount = data.clients.length;
          }
          break;
        }
        case 'removeClientByMatch': {
          if (body.name && body.phone) {
            data.clients = (data.clients || []).filter(
              c => !(c.name === body.name && c.phone === body.phone &&
                (body.time ? c.time === body.time : true))
            );
            data.intentCount = data.clients.length;
          }
          break;
        }
        case 'updateClient': {
          if (body.matchName && body.matchPhone && body.client) {
            data.clients = data.clients || [];
            const idx = data.clients.findIndex(c =>
              c.name === body.matchName &&
              c.phone === body.matchPhone &&
              (body.matchTime ? c.time === body.matchTime : true)
            );
            if (idx >= 0) {
              data.clients[idx] = body.client;
            } else {
              data.clients.push(body.client);
            }
            data.intentCount = data.clients.length;
          }
          break;
        }
        case 'updateClientNote': {
          if (body.name && body.phone && body.note !== undefined) {
            data.clients = (data.clients || []).map(c =>
              c.name === body.name && c.phone === body.phone ? { ...c, note: body.note } : c
            );
          }
          break;
        }
        case 'setTodayTodos':
          data.todayTodos = body.todos || [];
          break;
        case 'setTomorrowTodos':
          data.tomorrowTodos = body.todos || [];
          break;
        case 'setTempClients':
          data.tempClients = (body.tempClients || []).filter(function(tc){ return !tc.date || tc.date === date; });
          // Also persist full list to a dedicated cross-date KV key (去重后写入，防止历史重复数据累积)
          {
            const seenKeys = new Set();
            const dedupedMaster = [];
            for (const tc of (body.tempClients || [])) {
              const k = (tc.name || '') + '|' + (tc.phone || '') + '|' + (tc.date || '') + '|' + (tc.time || '');
              if (seenKeys.has(k)) continue;
              seenKeys.add(k);
              dedupedMaster.push(tc);
            }
            await env.DATA_KV.put('temp_clients:all', JSON.stringify(dedupedMaster));
          }
          break;
        case 'pushTodoLog':
          if (body.todo) {
            data.todoLog = [...(data.todoLog || []), body.todo];
          }
          break;
        case 'setScripts':
          data.scripts = body.scripts || [];
          break;
        case 'setLearns':
          data.learns = body.learns || [];
          break;
        case 'setAllClients':
          data.clients = body.clients || [];
          data.intentCount = (body.clients || []).length;
          break;
        case 'setWebhookUrl':
          data.webhookUrl = body.webhookUrl || '';
          await env.DATA_KV.put('config:webhook_url', data.webhookUrl);
          break;
        case 'setPinHash':
          await env.DATA_KV.put('config:pin_hash', body.pinHash || '');
          break;
        case 'setDeepseekApiKey':
          await env.DATA_KV.put('config:deepseek_api_key', body.deepseekApiKey || '');
          break;
        case 'setVisionConfig':
          if (body.visionApiKey !== undefined) await env.DATA_KV.put('config:vision_api_key', body.visionApiKey || '');
          if (body.visionApiBase !== undefined) await env.DATA_KV.put('config:vision_api_base', body.visionApiBase || '');
          break;
        case 'setAiConfig':
          if (body.aiProvider !== undefined) await env.DATA_KV.put('config:ai_provider', body.aiProvider || '');
          if (body.aiApiKey !== undefined) await env.DATA_KV.put('config:ai_api_key', body.aiApiKey || '');
          if (body.aiApiBase !== undefined) await env.DATA_KV.put('config:ai_api_base', body.aiApiBase || '');
          if (body.aiModel !== undefined) await env.DATA_KV.put('config:ai_model', body.aiModel || '');
          break;
        case 'setGoals':
          await env.DATA_KV.put('config:goals', JSON.stringify(body.goals || {}));
          break;
        case 'setJournal':
          await env.DATA_KV.put('journal:' + body.date, JSON.stringify(body.entries || []));
          break;
        case 'setMap':
          // 更新指定日期的计数（从目标 chip 编辑触发）
          var countFields = {
            'wechat_v1': 'wechatCount',
            'intent_v1': 'intentCount',
            'visit_v1': 'visitCount',
            'payment_v1': 'paymentCount'
          };
          var field = countFields[body.mapKey];
          if (field && body.date) {
            var dayRaw = await env.DATA_KV.get('work:' + body.date);
            var dayData = dayRaw ? JSON.parse(dayRaw) : { date: body.date, wechatCount: 0, intentCount: 0, revisitCount: 0, visitCount: 0, paymentCount: 0, clients: [], todayTodos: [], tomorrowTodos: [], tempClients: [], scripts: [], learns: [], todoLog: [] };
            dayData[field] = Math.max(0, body.value || 0);
            dayData._ts = Date.now();
            await env.DATA_KV.put('work:' + body.date, JSON.stringify(dayData));
          }
          break;
        default:
          return new Response(JSON.stringify({ error: '未知操作: ' + op }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
      }
      data._ts = ts;
      data.lastModified = new Date().toISOString();
      await env.DATA_KV.put(`work:${date}`, JSON.stringify(data));
      return new Response(JSON.stringify({ success: true, _ts: ts }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 获取日历数据
    if (path === '/api/calendar' && request.method === 'GET') {
      const month = url.searchParams.get('month');
      if (!month) {
        return new Response(JSON.stringify({ error: '缺少 month 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const keys = await getAllKVKeys(env, 'work:' + month);
      const keyValues = await getKVValuesConcurrently(env, keys);
      const calendar = {};
      for (const kv of keyValues) {
        if (kv.val) {
          try {
            const d = JSON.parse(kv.val);
            const dateKey = kv.name.replace('work:', '');
            calendar[dateKey] = {
              w: d.wechatCount || 0,
              i: d.intentCount || 0,
              r: d.revisitCount || 0,
              v: d.visitCount || 0,
              p: d.paymentCount || 0,
              t: (d.tempClients && d.tempClients.filter(function(tc){return tc.date===dateKey;}).length) || 0
            };
          } catch(e) {}
        }
      }
      return new Response(JSON.stringify(calendar), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 获取周/月统计
    if (path === '/api/stats' && request.method === 'GET') {
      const month = url.searchParams.get('month');
      if (!month) {
        return new Response(JSON.stringify({ error: '缺少 month 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const keys = await getAllKVKeys(env, 'work:' + month);
      const keyValues = await getKVValuesConcurrently(env, keys);
      let weekW = 0, monthW = 0, weekI = 0, monthI = 0, weekR = 0, monthR = 0, weekV = 0, monthV = 0, weekP = 0, monthP = 0;
      const today = new Date();
      const dow = today.getDay();
      const diff = (dow === 0 ? 6 : dow - 1);
      const mon = new Date(today);
      mon.setDate(today.getDate() - diff);
      const monStr = mon.getFullYear() + '-' + String(mon.getMonth()+1).padStart(2,'0') + '-' + String(mon.getDate()).padStart(2,'0');
      const todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
      for (const kv of keyValues) {
        if (kv.val) {
          try {
            const d = JSON.parse(kv.val);
            monthW += d.wechatCount || 0;
            monthI += d.intentCount || 0;
            monthR += d.revisitCount || 0;
            monthV += d.visitCount || 0;
            monthP += d.paymentCount || 0;
            if (d.date >= monStr && d.date <= todayStr) {
              weekW += d.wechatCount || 0;
              weekI += d.intentCount || 0;
              weekR += d.revisitCount || 0;
              weekV += d.visitCount || 0;
              weekP += d.paymentCount || 0;
            }
          } catch(e) {}
        }
      }
      const goals = JSON.parse(await env.DATA_KV.get('config:goals') || '{}');
      return new Response(JSON.stringify({ weekW, monthW, weekI, monthI, weekR, monthR, weekV, monthV, weekP, monthP, goals }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    // 壁纸代理 - 国风动漫 / 二次元
    // 注: birdpaper 已移除，因其仅支持 HTTP，Cloudflare Workers 禁止 outbound HTTP 请求。
    if (path === '/api/wallpaper' && request.method === 'GET') {
      const ALL = [
        'https://t.alcy.cc/',                       // 次元动漫 PC 横屏
        'https://t.alcy.cc/mp/',                     // 次元动漫 移动竖屏
        'https://api.dujin.org/pic/yuanshen/',       // 原神 国漫
        'https://api.paugram.com/wallpaper/',        // 保罗二次元
        'https://www.loliapi.com/acg/pe/',
        'https://www.loliapi.com/acg/',
        'https://t.mwm.moe/mp'
      ];
      const url = ALL[Math.floor(Math.random() * ALL.length)];
      return new Response(JSON.stringify({ url }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 账号认证 - KV 存储（单用户账号密码）
    async function authHash(s) {
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return Array.from(new Uint8Array(d)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
    }
    function authToken() {
      var arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      return Array.from(arr).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
    }
    if (path === '/api/auth/setup' && request.method === 'POST') {
      try {
        var body = await request.json();
        var existing = await env.DATA_KV.get('config:account_name');
        if (existing) return new Response(JSON.stringify({error:'账号已存在，请直接登录'}), {status:400,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
        await env.DATA_KV.put('config:account_name', body.username);
        await env.DATA_KV.put('config:account_hash', await authHash(body.password));
        var token = authToken();
        await env.DATA_KV.put('auth:session:' + token, JSON.stringify({username:body.username,created_at:Date.now()}));
        return new Response(JSON.stringify({access_token:token,username:body.username}), {headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
      } catch(e) { return new Response(JSON.stringify({error:e.message}), {status:500,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}}); }
    }
    if (path === '/api/auth/login' && request.method === 'POST') {
      try {
        var body = await request.json();
        var name = await env.DATA_KV.get('config:account_name');
        var hash = await env.DATA_KV.get('config:account_hash');
        if (!name || body.username !== name) return new Response(JSON.stringify({error:'账号不存在'}), {status:401,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
        if ((await authHash(body.password)) !== hash) return new Response(JSON.stringify({error:'密码错误'}), {status:401,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
        var token = authToken();
        await env.DATA_KV.put('auth:session:' + token, JSON.stringify({username:name,created_at:Date.now()}));
        return new Response(JSON.stringify({access_token:token,username:name}), {headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
      } catch(e) { return new Response(JSON.stringify({error:e.message}), {status:500,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}}); }
    }
    if (path === '/api/auth/user' && request.method === 'GET') {
      try {
        var auth = (request.headers.get('Authorization') || '').replace('Bearer ','');
        if (!auth) return new Response(JSON.stringify({error:'no token'}), {status:401,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
        var session = await env.DATA_KV.get('auth:session:' + auth);
        if (!session) return new Response(JSON.stringify({error:'invalid token'}), {status:401,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
        return new Response(session, {headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
      } catch(e) { return new Response(JSON.stringify({error:e.message}), {status:500,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}}); }
    }
    if (path === '/api/auth/logout' && request.method === 'POST') {
      try {
        var auth = (request.headers.get('Authorization') || '').replace('Bearer ','');
        if (auth) await env.DATA_KV.delete('auth:session:' + auth);
        return new Response(JSON.stringify({ok:true}), {headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
      } catch(e) { return new Response(JSON.stringify({error:e.message}), {status:500,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}}); }
    }

    // 获取全量意向客户
    if (path === '/api/all-clients' && request.method === 'GET') {
      const keys = await getAllKVKeys(env, 'work:');
      const keyValues = await getKVValuesConcurrently(env, keys);
      const allClients = [];
      for (const kv of keyValues) {
        if (kv.val) {
          try {
            const d = JSON.parse(kv.val);
            if (d.clients) {
              d.clients.forEach(c => {
                c.date = c.date || kv.name.replace('work:', '');
                allClients.push(c);
              });
            }
          } catch(e) {}
        }
      }
      allClients.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return new Response(JSON.stringify(allClients), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 获取全量临时登记客户
    if (path === '/api/all-temp-clients' && request.method === 'GET') {
      // Read from dedicated cross-date KV key (preferred)
      const masterRaw = await env.DATA_KV.get('temp_clients:all');
      if (masterRaw) {
        try {
          const all = JSON.parse(masterRaw);
          // 去重：与 fallback 路径一致，防止历史脏数据重复显示
          const seen = new Set();
          const deduped = [];
          for (const c of all) {
            const uniq = (c.name || '') + '|' + (c.phone || '') + '|' + (c.date || '') + '|' + (c.time || '');
            if (!seen.has(uniq)) {
              seen.add(uniq);
              deduped.push(c);
            }
          }
          deduped.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
          return new Response(JSON.stringify(deduped), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        } catch(e) {}
      }
      // Fallback: aggregate from per-date entries (backward compat)
      const keys = await getAllKVKeys(env, 'work:');
      const keyValues = await getKVValuesConcurrently(env, keys);
      const allTempClients = [];
      const seen = new Set();
      for (const kv of keyValues) {
        if (kv.val) {
          try {
            const d = JSON.parse(kv.val);
            if (d.tempClients) {
              d.tempClients.forEach(c => {
                c.date = c.date || kv.name.replace('work:', '');
                const uniq = c.name + '|' + c.phone + '|' + c.date + '|' + (c.time||'');
                if (!seen.has(uniq)) {
                  seen.add(uniq);
                  allTempClients.push(c);
                }
              });
            }
          } catch(e) {}
        }
      }
      allTempClients.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return new Response(JSON.stringify(allTempClients), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 导出数据并发送企业微信 webhook
    if (path === '/api/export' && request.method === 'POST') {
      const body = await request.json();
      const { type, webhookUrl } = body;
      if (!type) {
        return new Response(JSON.stringify({ error: '缺少 type 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      let target;
      if (webhookUrl && webhookUrl.trim() !== '') {
        // SSRF Defence: Only allow official Weixin Work domain prefixes
        if (!webhookUrl.startsWith('https://qyapi.weixin.qq.com/')) {
          return new Response(JSON.stringify({ error: 'SSRF 安全防御：仅允许向企业微信官方域名发送 Webhook 请求' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        target = webhookUrl.trim();
      } else {
        return new Response(JSON.stringify({ error: '缺少 Webhook URL' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // 导出单个意向客户
      if (type === 'single_client') {
        const client = body.client;
        if (!client) {
          return new Response(JSON.stringify({ error: '缺少 client 参数' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
        const datePart = (client.date || '').slice(5);
        const wk = client.date ? ' 周' + weekNames[new Date(client.date + 'T00:00:00').getDay()] : '';
        
        let text = '> 客户姓名：' + client.name + '\n';
        text += '> 日期：' + datePart + wk + ' | 时间：' + (client.time || '') + '\n';
        text += '> 电话：' + (client.phone || '') + '\n';
        text += '> 单位名称：' + (client.company || '') + '\n';
        text += '> 公积金基数：' + (client.fund || '') + '\n';
        text += '> 社保养老基数：' + (client.socialSecurity || '') + '\n';
        text += '> 月均工资：' + (client.avgSalary || '') + '\n';
        text += '> 近2年个税：' + (client.tax2yr || '') + '\n';
        text += '> 代发工资银行：' + (client.salaryBank || '') + '\n';
        text += '> 学历：' + (client.education || '') + '\n';
        text += '> 婚姻状况：' + (client.maritalStatus || '') + '\n';
        text += '> 是否深户：' + (client.isShenzhenHukou || '') + '\n';
        text += '> 房产：' + (client.property || '') + '\n';
        if (client.propertyType) text += '> 深房/外地房：' + client.propertyType + '\n';
        if (client.propertyAddress) text += '> 房产地址：' + client.propertyAddress + '\n';
        if (client.propertyArea) text += '> 面积：' + client.propertyArea + '\n';
        if (client.propertyMortgageBank) text += '> 抵押银行：' + client.propertyMortgageBank + '\n';
        if (client.propertyMortgageAmount) text += '> 还欠多少：' + client.propertyMortgageAmount + '\n';
        if (client.propertyOther) text += '> 房产其他情况：' + client.propertyOther + '\n';
        text += '> 客户年龄：' + (client.age || '') + '\n';
        text += '> 银行信贷负债：' + (client.bankDebt || '') + '\n';
        text += '> 信用卡负债：' + (client.creditCardDebt || '') + '\n';
        text += '> 近3个月查询次数：' + (client.query3m || '') + '\n';
        text += '> 小额网贷笔数：' + (client.onlineLoanCount || '') + '\n';
        text += '> 客户大致需求：' + (client.demand || '').replace(/\n/g, ' ') + '\n';
        text += '> 资金用途和时间：' + (client.fundUsage || '').replace(/\n/g, ' ') + '\n';
        text += '> 沟通记录：' + (client.note || '').replace(/\n/g, ' ') + '\n';
        if (client.followUps && client.followUps.length > 0) {
          text += '> 跟进记录：\n';
          client.followUps.forEach(function(fu) {
            text += '>   [' + (fu.date || '') + ' ' + (fu.time || '') + '] ' + (fu.content || '').replace(/\n/g, ' ') + '\n';
          });
        } else if (client.followUp) {
          text += '> 跟进情况：' + client.followUp.replace(/\n/g, ' ') + '\n';
        }
        if (client.status) text += '> 状态：' + (client.status==='success'?'已办理成功':'未办理成功') + '\n';
        var kqText = formatKeyQuestions(client.keyQuestions);
        if (kqText) text += '> 关键问题：' + kqText + '\n';

        try {
          await sendMarkdownMessage(env, target, text);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: '发送遇到错误: ' + e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }

      // 导出单个临时登记客户
      if (type === 'temp_single_client') {
        const client = body.client;
        if (!client) {
          return new Response(JSON.stringify({ error: '缺少 client 参数' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
        const datePart = (client.date || '').slice(5);
        const wk = client.date ? ' 周' + weekNames[new Date(client.date + 'T00:00:00').getDay()] : '';

        let text = '> 客户姓名：' + client.name + '\n';
        text += '> 日期：' + datePart + wk + ' | 时间：' + (client.time || '') + '\n';
        text += '> 电话：' + (client.phone || '') + '\n';
        text += '> 单位名称：' + (client.company || '') + '\n';
        text += '> 公积金：' + (client.fund || '') + '\n';
        text += '> 沟通内容：' + (client.note || '').replace(/\n/g, ' ') + '\n';
        if (client.followUps && client.followUps.length > 0) {
          text += '> 跟进记录：\n';
          client.followUps.forEach(function(fu) {
            text += '>   [' + (fu.date || '') + ' ' + (fu.time || '') + '] ' + (fu.content || '').replace(/\n/g, ' ') + '\n';
          });
        }
        var kqText2 = formatKeyQuestions(client.keyQuestions);
        if (kqText2) text += '> 关键问题：' + kqText2 + '\n';

        try {
          await sendMarkdownMessage(env, target, text);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: '发送遇到错误: ' + e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }

      // 导出全量意向客户
      if (type === 'all_clients') {
        const keys = await getAllKVKeys(env, 'work:');
        const keyValues = await getKVValuesConcurrently(env, keys);
        const allClients = [];
        for (const kv of keyValues) {
          if (kv.val) {
            try {
              const d = JSON.parse(kv.val);
              if (d.clients) {
                (d.clients || []).forEach(c => {
                  allClients.push({ ...c, date: c.date || kv.name.replace('work:', '') });
                });
              }
            } catch(e) {}
          }
        }
        allClients.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
        const total = allClients.length;

        const baseHeader = '### 意向客户全量表\n> 共计 **' + total + '** 位意向客户\n\n---\n\n';
        const itemFormatter = (c) => {
          const datePart = (c.date || '').slice(5);
          const wk = c.date ? ' 周' + weekNames[new Date(c.date + 'T00:00:00').getDay()] : '';
          let itemText = '> 客户姓名：' + c.name + '\n';
          itemText += '> 日期：' + datePart + wk + ' | 时间：' + (c.time || '') + '\n';
          itemText += '> 电话：' + (c.phone || '') + '\n';
          itemText += '> 单位名称：' + (c.company || '') + '\n';
          itemText += '> 公积金基数：' + (c.fund || '') + '\n';
          itemText += '> 社保养老基数：' + (c.socialSecurity || '') + '\n';
          itemText += '> 月均工资：' + (c.avgSalary || '') + '\n';
          itemText += '> 近2年个税：' + (c.tax2yr || '') + '\n';
          itemText += '> 代发工资银行：' + (c.salaryBank || '') + '\n';
          itemText += '> 学历：' + (c.education || '') + '\n';
          itemText += '> 婚姻状况：' + (c.maritalStatus || '') + '\n';
          itemText += '> 是否深户：' + (c.isShenzhenHukou || '') + '\n';
          itemText += '> 房产：' + (c.property || '') + '\n';
          if (c.propertyType) itemText += '> 深房/外地房：' + c.propertyType + '\n';
          if (c.propertyAddress) itemText += '> 房产地址：' + c.propertyAddress + '\n';
          if (c.propertyArea) itemText += '> 面积：' + c.propertyArea + '\n';
          if (c.propertyMortgageBank) itemText += '> 抵押银行：' + c.propertyMortgageBank + '\n';
          if (c.propertyMortgageAmount) itemText += '> 还欠多少：' + c.propertyMortgageAmount + '\n';
          if (c.propertyOther) itemText += '> 房产其他情况：' + c.propertyOther + '\n';
          itemText += '> 客户年龄：' + (c.age || '') + '\n';
          itemText += '> 银行信贷负债：' + (c.bankDebt || '') + '\n';
          itemText += '> 信用卡负债：' + (c.creditCardDebt || '') + '\n';
          itemText += '> 近3个月查询次数：' + (c.query3m || '') + '\n';
          itemText += '> 小额网贷笔数：' + (c.onlineLoanCount || '') + '\n';
          itemText += '> 客户大致需求：' + (c.demand || '').replace(/\n/g, ' ') + '\n';
          itemText += '> 资金用途和时间：' + (c.fundUsage || '').replace(/\n/g, ' ') + '\n';
          itemText += '> 沟通记录：' + (c.note || '').replace(/\n/g, ' ') + '\n';
          if (c.followUps && c.followUps.length > 0) {
            itemText += '> 跟进记录：\n';
            c.followUps.forEach(function(fu) {
              itemText += '>   [' + (fu.date||'') + ' ' + (fu.time||'') + '] ' + (fu.content||'').replace(/\n/g, ' ') + '\n';
            });
          } else if (c.followUp) {
            itemText += '> 跟进情况：' + c.followUp.replace(/\n/g, ' ') + '\n';
          }
          if (c.status) itemText += '> 状态：' + (c.status==='success'?'已办理成功':'未办理成功') + '\n';
          var kqBulk = formatKeyQuestions(c.keyQuestions);
          if (kqBulk) itemText += '> 关键问题：' + kqBulk + '\n';
          itemText += '\n';
          return itemText;
        };

        try {
          await sendWebhookMarkdown(env, target, baseHeader, allClients, itemFormatter);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: '发送失败: ' + e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }

      // 逐条导出全量意向客户（每个客户一条消息）
      if (type === 'all_clients_solo') {
        const keys = await getAllKVKeys(env, 'work:');
        const keyValues = await getKVValuesConcurrently(env, keys);
        const allClients = [];
        for (const kv of keyValues) {
          if (kv.val) {
            try {
              const d = JSON.parse(kv.val);
              if (d.clients) {
                (d.clients || []).forEach(c => {
                  allClients.push({ ...c, date: c.date || kv.name.replace('work:', '') });
                });
              }
            } catch(e) {}
          }
        }
        allClients.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
        const buildText = (c) => {
          const datePart = (c.date || '').slice(5);
          const wk = c.date ? ' 周' + weekNames[new Date(c.date + 'T00:00:00').getDay()] : '';
          let text = '> 客户姓名：' + c.name + '\n';
          text += '> 日期：' + datePart + wk + ' | 时间：' + (c.time || '') + '\n';
          text += '> 电话：' + (c.phone || '') + '\n';
          text += '> 单位名称：' + (c.company || '') + '\n';
          text += '> 公积金基数：' + (c.fund || '') + '\n';
          text += '> 社保养老基数：' + (c.socialSecurity || '') + '\n';
          text += '> 月均工资：' + (c.avgSalary || '') + '\n';
          text += '> 近2年个税：' + (c.tax2yr || '') + '\n';
          text += '> 代发工资银行：' + (c.salaryBank || '') + '\n';
          text += '> 学历：' + (c.education || '') + '\n';
          text += '> 婚姻状况：' + (c.maritalStatus || '') + '\n';
          text += '> 是否深户：' + (c.isShenzhenHukou || '') + '\n';
          text += '> 房产：' + (c.property || '') + '\n';
          if (c.propertyType) text += '> 深房/外地房：' + c.propertyType + '\n';
          if (c.propertyAddress) text += '> 房产地址：' + c.propertyAddress + '\n';
          if (c.propertyArea) text += '> 面积：' + c.propertyArea + '\n';
          if (c.propertyMortgageBank) text += '> 抵押银行：' + c.propertyMortgageBank + '\n';
          if (c.propertyMortgageAmount) text += '> 还欠多少：' + c.propertyMortgageAmount + '\n';
          if (c.propertyOther) text += '> 房产其他情况：' + c.propertyOther + '\n';
          text += '> 客户年龄：' + (c.age || '') + '\n';
          text += '> 银行信贷负债：' + (c.bankDebt || '') + '\n';
          text += '> 信用卡负债：' + (c.creditCardDebt || '') + '\n';
          text += '> 近3个月查询次数：' + (c.query3m || '') + '\n';
          text += '> 小额网贷笔数：' + (c.onlineLoanCount || '') + '\n';
          text += '> 客户大致需求：' + (c.demand || '').replace(/\n/g, ' ') + '\n';
          text += '> 资金用途和时间：' + (c.fundUsage || '').replace(/\n/g, ' ') + '\n';
          text += '> 沟通记录：' + (c.note || '').replace(/\n/g, ' ') + '\n';
          if (c.followUps && c.followUps.length > 0) {
            text += '> 跟进记录：\n';
            c.followUps.forEach(function(fu) {
              text += '>   [' + (fu.date||'') + ' ' + (fu.time||'') + '] ' + (fu.content||'').replace(/\n/g, ' ') + '\n';
            });
          } else if (c.followUp) {
            text += '> 跟进情况：' + c.followUp.replace(/\n/g, ' ') + '\n';
          }
          if (c.status) text += '> 状态：' + (c.status==='success'?'已办理成功':'未办理成功') + '\n';
          return text;
        };

        let sent = 0, failed = 0;
        const concurrency = 3;
        for (let i = 0; i < allClients.length; i += concurrency) {
          const batch = allClients.slice(i, i + concurrency);
          const results = await Promise.all(batch.map(async (c) => {
            try {
              await sendMarkdownMessage(env, target, buildText(c));
              return true;
            } catch(e) { return false; }
          }));
          for (const r of results) {
            if (r) sent++; else failed++;
          }
        }

        return new Response(JSON.stringify({ success: true, sent, failed, total: allClients.length }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const today = new Date();
      const dow = today.getDay();
      const diff = dow === 0 ? 6 : dow - 1;
      const mon = new Date(today);
      mon.setDate(today.getDate() - diff);
      const monStr = mon.getFullYear() + '-' + String(mon.getMonth()+1).padStart(2,'0') + '-' + String(mon.getDate()).padStart(2,'0');
      const todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
      const monthPrefix = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0');

      const keys = await getAllKVKeys(env, 'work:' + monthPrefix);
      const keyValues = await getKVValuesConcurrently(env, keys);
      let weekW = 0, monthW = 0, weekI = 0, monthI = 0, weekR = 0, monthR = 0, weekT = 0, monthT = 0;
      const sorted = [];
      for (const kv of keyValues) {
        if (!kv.val) continue;
        try {
          const d = JSON.parse(kv.val);
          sorted.push(d);
          monthW += d.wechatCount || 0;
          monthI += d.intentCount || 0;
          monthR += d.revisitCount || 0;
          monthT += (d.tempClients || []).length;
          if (d.date >= monStr && d.date <= todayStr) {
            weekW += d.wechatCount || 0;
            weekI += d.intentCount || 0;
            weekR += d.revisitCount || 0;
            weekT += (d.tempClients || []).length;
          }
        } catch(e) {}
      }
      sorted.sort((a,b) => (a.date||'').localeCompare(b.date||''));

      const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
      const title = type === 'week' ? '本周数据统计' : '本月数据统计';
      const dateRange = type === 'week'
        ? monStr + ' ～ ' + todayStr
        : monthPrefix + '-01 ～ ' + todayStr;
      const wTotal = type === 'week' ? weekW : monthW;
      const iTotal = type === 'week' ? weekI : monthI;
      const rTotal = type === 'week' ? weekR : monthR;
      const tTotal = type === 'week' ? weekT : monthT;

      const baseHeader = '### ' + title + '\n' +
        '> ' + dateRange + '\n\n' +
        '<font color="info">新增微信：**' + wTotal + '**</font>\n' +
        '<font color="warning">新增意向：**' + iTotal + '**</font>\n' +
        '<font color="comment">客户回访：**' + rTotal + '**</font>\n' +
        '<font color="comment">临时登记：**' + tTotal + '** 人</font>\n' +
        (type !== 'week' ? '\n> 本周参考: 微信 **' + weekW + '** | 意向 **' + weekI + '** | 回访 **' + weekR + '** | 临时 **' + weekT + '**\n' : '') +
        '\n---\n\n';

      const activeDays = sorted.filter(d => {
        if (type === 'week' && (d.date < monStr || d.date > todayStr)) return false;
        return true;
      });

      const itemFormatter = (d) => {
        const datePart = d.date.slice(5);
        const wk = '周' + weekNames[new Date(d.date + 'T00:00:00').getDay()];
        const w = d.wechatCount || 0;
        const it = d.intentCount || 0;
        const r = d.revisitCount || 0;
        
        const clients = d.clients || [];
        let detail = '';
        if (clients.length > 0) {
          detail = clients.map(c => c.name + (c.company ? ' [' + c.company + ']' : '') + (c.fund ? ' {' + c.fund + '}' : '') + (c.note ? ' （' + c.note + '）' : '')).join('\n> ');
        } else {
          detail = '*(无新增意向)*';
        }
        
        let itemText = '**' + datePart + ' ' + wk + '**\n';
        itemText += '> <font color="info">微信: ' + w + '</font> | <font color="warning">意向: ' + it + '</font> | <font color="comment">回访: ' + r + '</font>\n';
        itemText += '> ' + detail + '\n\n';
        return itemText;
      };

      try {
        await sendWebhookMarkdown(env, target, baseHeader, activeDays, itemFormatter);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: '发送失败: ' + e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ==================== HTML 页面 ====================
    
    const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=yes, viewport-fit=cover, shrink-to-fit=no">
  <title>生活记事录</title>
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#ededed">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon.svg">
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=_onTurnstileLoad&render=explicit" async defer></script>
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/inter@5/400.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/inter@5/500.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/inter@5/600.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/inter@5/700.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg-app: rgba(237,237,237,0.88);
      --card-bg: rgba(255,255,255,0.80);
      --card-border: rgba(0,0,0,0.04);
      --separator: rgba(0,0,0,0.08);
      --text-main: #1c1c1e;
      --text-soft: #3a3a3c;
      --text-light: #5c5c60;
      --accent-wechat: #34D399;
      --accent-intent: #FB8C00;
      --accent-wechat-bg: #ECFDF5;
      --accent-intent-bg: #FFF8F0;
      --accent-btn: rgba(52,211,153,0.75);
      --btn-bg: rgba(255,255,255,0.92);
      --btn-hover: #e5e5e5;
      --shadow-card: 0 2px 12px rgba(0,0,0,0.06);
      --cal-hover: #f2f2f7;
      --cal-today: rgba(255,255,255,0.55);
      --border-light: #eaeaeb;
      --tooltip-bg: #1c1c1e;
      --tooltip-text: #ffffff;
      --modal-bg: rgba(0,0,0,0.3);
      --modal-card: rgba(255,255,255,0.55);
      --radius-ios: 16px;
      --radius-md: 12px;
      --radius-sm: 10px;
      --radius-xs: 8px;
      --radius-capsule: 999px;
      --wechat-gradient: linear-gradient(135deg, #C8F5D8 0%, #7EE8A0 50%, #34D399 100%);
      --intent-gradient: linear-gradient(135deg, #FFE8C0 0%, #FFC870 50%, #FF9500 100%);
      --revisit-gradient: linear-gradient(135deg, #C8D8FF 0%, #7B9FF5 50%, #4A6CF7 100%);
      --visit-gradient: linear-gradient(135deg, #c8e6c9 0%, #66bb6a 50%, #388e3c 100%);
      --payment-gradient: linear-gradient(135deg, #fff9c4 0%, #ffd54f 50%, #f9a825 100%);
      --today-gradient: linear-gradient(135deg, #ffe0cc 0%, #ffab7a 50%, #ff7744 100%);
      --stats-gradient: linear-gradient(135deg, #d4f0f0 0%, #80cbc4 50%, #26a69a 100%);
      --wallpaper-url: '';
      --wallpaper-opacity: 0.45;
    }
    body.dark-mode {
      --bg-app: rgba(17,17,17,0.5);
      --card-bg: rgba(28,28,30,0.45);
      --card-border: rgba(255,255,255,0.06);
      --separator: rgba(255,255,255,0.1);
      --text-main: #f2f2f7;
      --text-soft: #aeaeb2;
      --text-light: #aeaeb2;
      --accent-wechat: #34D399;
      --accent-intent: #FBA95C;
      --accent-wechat-bg: #064E3B;
      --accent-intent-bg: #3D2A18;
      --accent-btn: rgba(52,211,153,0.40);
      --btn-bg: rgba(255,255,255,0.12);
      --btn-hover: #2c2c2c;
      --cal-hover: #2c2c2e;
      --shadow-card: 0 2px 16px rgba(0,0,0,0.4);
      --cal-today: rgba(255,255,255,0.4);
      --border-light: #2c2c2e;
      --tooltip-bg: #e5e5e5;
      --tooltip-text: #111111;
      --modal-bg: rgba(0,0,0,0.5);
      --modal-card: rgba(28,28,30,0.5);
      --wechat-gradient: linear-gradient(135deg, #0D3320 0%, #144D2E 50%, #1A6B3A 100%);
      --intent-gradient: linear-gradient(135deg, #3D2818 0%, #5D3A1C 50%, #804D20 100%);
      --revisit-gradient: linear-gradient(135deg, #1C2840 0%, #2A3D60 50%, #3A5280 100%);
      --visit-gradient: linear-gradient(135deg, #1b3320 0%, #2d5a30 50%, #3d7a40 100%);
      --payment-gradient: linear-gradient(135deg, #332b10 0%, #5a4a1a 50%, #7a6a20 100%);
      --today-gradient: linear-gradient(135deg, #2a1a0d 0%, #3d2614 50%, #52331a 100%);
      --stats-gradient: linear-gradient(135deg, #0d2626 0%, #143d3d 50%, #1a5252 100%);
      --wallpaper-opacity: 0.35;
    }
    html { height: 100%; width: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: none; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    body { min-height: 100vh; width: 100%; background: var(--bg-app); font-family: Inter, "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif; font-weight: 400; letter-spacing: -0.01em; text-rendering: optimizeLegibility; transition: background 0.3s; position: relative; line-height: 1.45; }
    .wallpaper-background { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; background-image: var(--wallpaper-url); background-size: cover; background-position: center; background-repeat: no-repeat; opacity: var(--wallpaper-opacity); transition: opacity 0.8s ease, background-image 0.8s ease; pointer-events: none; }
    body.dark-mode .wallpaper-background { opacity: 0.12; }
    .wallpaper-fallback { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; background: linear-gradient(135deg, #a8e6cf 0%, #dcedc1 100%); opacity: 0.15; pointer-events: none; }
    body.dark-mode .wallpaper-fallback { background: linear-gradient(180deg, #0a0a0a 0%, #141414 50%, #0d0d0d 100%); opacity: 0.6; }
    .privacy-mask { display: none; position: fixed; inset: 0; background: transparent; z-index: 9999; flex-direction: column; justify-content: center; align-items: center; gap: 2rem; color: var(--text-main); font-weight: 700; pointer-events: none; }
    .privacy-wallpaper { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 9998; background-image: var(--wallpaper-url); background-size: cover; background-position: center; background-repeat: no-repeat; opacity: 0; transition: opacity 0.5s ease; pointer-events: none; }
    body.page-hidden .privacy-wallpaper { opacity: 1; pointer-events: auto; }
    body.dark-mode.page-hidden .privacy-wallpaper { opacity: 1; }
    body.page-hidden .privacy-mask { display: flex; pointer-events: auto; }
    body.page-hidden .app-shell { display: none; }
    .pin-box { display: flex; flex-direction: column; align-items: center; gap: 18px; background: rgba(255,255,255,0.55); backdrop-filter: blur(50px) saturate(180%); -webkit-backdrop-filter: blur(50px) saturate(180%); padding: 36px 44px; border-radius: 24px; box-shadow: 0 8px 32px rgba(0,0,0,0.12), inset 0 0.5px 0 rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.3); min-width: 360px; max-width: 480px; z-index: 45; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }
    body.dark-mode .pin-box { background: rgba(20,20,20,0.4); backdrop-filter: blur(50px) saturate(180%); -webkit-backdrop-filter: blur(50px) saturate(180%); border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 8px 32px rgba(0,0,0,0.35), inset 0 0.5px 0 rgba(255,255,255,0.1); }
    .pin-stats { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }
    .pin-stat-item { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 16px; background: rgba(255,255,255,0.12); border-radius: var(--radius-sm); border: 1px solid rgba(255,255,255,0.15); min-width: 110px; flex: 1; }
    body.dark-mode .pin-stat-item { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.06); }
    .pin-stat-label { font-size: 0.82rem; font-weight: 500; color: var(--text-soft); letter-spacing: -0.01em; white-space: nowrap; }
    .pin-stat-value { font-size: 2.2rem; font-weight: 700; line-height: 1; }
    .pin-wechat-value { background: var(--wechat-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-intent-value { background: var(--intent-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-revisit-value { background: var(--revisit-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-visit-value { background: var(--visit-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-payment-value { background: var(--payment-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-input { width: 196px; padding: 11px 20px; border-radius: var(--radius-xs); border: 1.5px solid rgba(0,0,0,0.08); background: rgba(255,255,255,0.65); text-align: center; font-size: 1.4rem; letter-spacing: 7px; color: var(--text-main); outline: none; font-weight: 700; transition: all 0.3s; }
    body.dark-mode .pin-input { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.1); }
    .pin-input:focus { background: rgba(255,255,255,0.60); }
    .pin-mask { -webkit-text-security: disc; }
    .pin-btn { background: var(--accent-btn); border: none; color: white; padding: 8px 22px; border-radius: var(--radius-sm); font-weight: 600; cursor: pointer; font-size: 0.92rem; letter-spacing: -0.01em; transition: all 0.2s; }
    .pin-btn:hover { opacity: 0.9; transform: translateY(-2px); box-shadow: 0 6px 20px rgba(255,255,255,0.6); }
    .pin-btn:active { transform: translateY(0); }
    .pin-error { color: #e74c3c; font-size: 1.26rem; min-height: 24px; font-weight: 700; letter-spacing: 0.5px; }
    .auth-gate { display: none; position: fixed; inset: 0; background: transparent; z-index: 10000; flex-direction: column; justify-content: center; align-items: center; }
    body.page-auth .auth-gate { display: flex; }
    body.page-auth .privacy-mask { display: none; }
    body.page-auth .app-shell { display: none; }
    .auth-box { display: flex; flex-direction: column; align-items: center; gap: 20px; background: rgba(255,255,255,0.55); backdrop-filter: blur(50px) saturate(180%); -webkit-backdrop-filter: blur(50px) saturate(180%); padding: 45px 50px; border-radius: 28px; box-shadow: 0 8px 32px rgba(0,0,0,0.12), inset 0 0.5px 0 rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.3); min-width: 380px; max-width: 460px; }
    body.dark-mode .auth-box { background: rgba(20,20,20,0.4); backdrop-filter: blur(50px) saturate(180%); -webkit-backdrop-filter: blur(50px) saturate(180%); border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 8px 32px rgba(0,0,0,0.35), inset 0 0.5px 0 rgba(255,255,255,0.1); }
    .auth-title { font-size: 1.5rem; font-weight: 700; color: var(--text-main); letter-spacing: 1px; margin: 0; }
    .auth-form { display: flex; flex-direction: column; gap: 14px; width: 100%; align-items: center; }
    .auth-input { width: 100%; padding: 12px 16px; border-radius: 8px; border: 1.5px solid rgba(0,0,0,0.08); background: rgba(255,255,255,0.65); font-size: 1rem; color: var(--text-main); outline: none; transition: all 0.3s; box-sizing: border-box; }
    body.dark-mode .auth-input { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.1); }
    .auth-input:focus { background: rgba(255,255,255,0.60); border-color: var(--accent-main); box-shadow: 0 0 0 3px rgba(52,211,153,0.15); }
    .auth-btn { width: 100%; background: var(--accent-btn); border: none; color: white; padding: 12px 20px; border-radius: var(--radius-sm); font-weight: 600; cursor: pointer; font-size: 1.05rem; letter-spacing: -0.01em; transition: all 0.2s; }
    .auth-btn:hover { opacity: 0.9; transform: translateY(-2px); box-shadow: 0 6px 20px rgba(255,255,255,0.6); }
    .auth-btn:active { transform: translateY(0); }
    .auth-switch { font-size: 0.88rem; color: var(--text-soft); }
    .auth-switch a { color: var(--accent-main); cursor: pointer; text-decoration: none; font-weight: 700; }
    .auth-switch a:hover { text-decoration: underline; }
    .auth-error { color: #e74c3c; font-size: 0.95rem; min-height: 20px; font-weight: 700; text-align: center; }
    /* ====== 日记首页 ====== */
    .journal-shell { display: none; min-height: 100vh; width: 100%; flex-direction: column; position: relative; z-index: 1; }
    body.page-journal .journal-shell { display: flex !important; }
    body.page-journal .app-shell { display: none !important; }
    .topbar { display: flex; align-items: center; gap: 16px; padding: 0 20px; height: 44px; flex-shrink: 0; background: rgba(255,255,255,0.70); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border-bottom: 0.5px solid var(--separator); z-index: 10; }
    body.dark-mode .topbar { background: rgba(20,20,20,0.5); border-bottom: 0.5px solid var(--separator); }
    .topbar-logo { font-size: 1.1rem; font-weight: 700; color: var(--text-main); letter-spacing: 0.5px; white-space: nowrap; }
    .topbar-search { flex: 1; max-width: 360px; padding: 8px 14px; border-radius: 20px; border: 1px solid rgba(0,0,0,0.08); background: rgba(255,255,255,0.75); font-size: 0.9rem; color: var(--text-main); outline: none; transition: all 0.2s; }
    body.dark-mode .topbar-search { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.1); }
    .topbar-search:focus { border-color: var(--accent-main); box-shadow: 0 0 0 3px rgba(52,211,153,0.12); }
    .topbar-btn { padding: 8px 18px; border-radius: var(--radius-capsule); border: none; background: var(--accent-btn); color: white; font-weight: 600; font-size: 0.9rem; cursor: pointer; transition: all 0.2s; white-space: nowrap; letter-spacing: -0.01em; }
    .topbar-btn:hover { opacity: 0.9; transform: translateY(-1px); }
    .topbar-user { font-size: 0.85rem; color: var(--text-soft); white-space: nowrap; cursor: pointer; }
    .journal-body { display: flex; flex: 1; min-height: 0; }
    .sidebar { width: 170px; flex-shrink: 0; display: flex; flex-direction: column; gap: 2px; padding: 12px 8px; background: rgba(255,255,255,0.52); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border-right: 0.5px solid var(--separator); overflow-y: auto; }
    body.dark-mode .sidebar { background: rgba(20,20,20,0.3); border-right: 0.5px solid var(--separator); }
    .sidebar-item { display: block; padding: 10px 14px; border-radius: var(--radius-sm); font-size: 0.9rem; font-weight: 600; color: var(--text-soft); text-decoration: none; cursor: pointer; transition: all 0.15s; }
    .sidebar-item:hover { background: rgba(0,0,0,0.04); color: var(--text-main); }
    body.dark-mode .sidebar-item:hover { background: rgba(255,255,255,0.06); }
    .sidebar-item.active { background: var(--accent-btn); color: white; }
    body.dark-mode .sidebar-item.active { background: var(--accent-btn); color: white; }
    .journal-main { flex: 1; padding: 8px 28px calc(24px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 20px; }
    .journal-main .section-title { font-size: 1.1rem; font-weight: 600; color: var(--text-main); margin: 0; }
    .journal-card { background: rgba(255,255,255,0.80); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border-radius: var(--radius-md); border: 0.5px solid var(--card-border); padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-card); }
    body.dark-mode .journal-card { background: rgba(30,30,30,0.5); border: 0.5px solid var(--card-border); }
    .journal-meta { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
    .journal-meta-tag { padding: 6px 12px; border-radius: var(--radius-capsule); background: rgba(0,0,0,0.04); font-size: 0.85rem; color: var(--text-main); font-weight: 500; }
    body.dark-mode .journal-meta-tag { background: rgba(255,255,255,0.08); }
    .journal-meta-tag select { border: none; background: transparent; font: inherit; color: inherit; outline: none; cursor: pointer; }
    .journal-content { font-size: 1rem; font-weight: 400; color: var(--text-main); line-height: 1.6; white-space: pre-wrap; word-break: break-word; letter-spacing: -0.01em; }
    .journal-media-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .journal-media-thumb { width: 80px; height: 80px; border-radius: 8px; object-fit: cover; cursor: pointer; border: 1px solid rgba(0,0,0,0.06); }
    .journal-actions { display: flex; gap: 10px; }
    .journal-act-btn { padding: 6px 14px; border-radius: 14px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.72); font-size: 0.82rem; color: var(--text-soft); cursor: pointer; transition: all 0.15s; }
    body.dark-mode .journal-act-btn { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.1); }
    .journal-act-btn:hover { background: rgba(0,0,0,0.06); color: var(--text-main); }
    .journal-editor { background: rgba(255,255,255,0.80); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border-radius: var(--radius-md); border: 0.5px solid var(--card-border); padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; box-shadow: var(--shadow-card); }
    body.dark-mode .journal-editor { background: rgba(30,30,30,0.5); border: 0.5px solid var(--card-border); }
    .journal-editor textarea { width: 100%; min-height: 120px; padding: 12px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.82); font: inherit; font-size: 0.95rem; color: var(--text-main); outline: none; resize: vertical; line-height: 1.7; box-sizing: border-box; }
    body.dark-mode .journal-editor textarea { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.1); }
    .journal-editor-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .journal-editor-row select { padding: 6px 10px; border-radius: 14px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.75); font-size: 0.85rem; color: var(--text-main); outline: none; }
    body.dark-mode .journal-editor-row select { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.1); }
    .journal-empty { text-align: center; padding: 60px 20px; color: var(--text-soft); font-size: 1rem; }
    .cal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .cal-title { font-size: 1.1rem; font-weight: 700; color: var(--text-main); }
    .cal-nav { width: 36px; height: 36px; border: 1px solid rgba(0,0,0,0.1); border-radius: 50%; background: rgba(255,255,255,0.65); cursor: pointer; font-size: 1rem; color: var(--text-main); display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
    body.dark-mode .cal-nav { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.1); }
    .cal-nav:hover { background: rgba(0,0,0,0.08); }
    .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
    .cal-wd { text-align: center; font-size: 0.78rem; font-weight: 700; color: var(--text-soft); padding: 6px 0; }
    .cal-cell { position: relative; text-align: center; padding: 10px 2px; cursor: pointer; border-radius: var(--radius-sm); transition: background 0.15s; min-height: 40px; display: flex; flex-direction: column; align-items: center; gap: 3px; }
    .cal-cell:hover { background: rgba(0,0,0,0.04); }
    body.dark-mode .cal-cell:hover { background: rgba(255,255,255,0.06); }
    .cal-cell.cal-empty { cursor: default; }
    .cal-dnum { font-size: 0.92rem; font-weight: 700; color: var(--text-main); }
    .cal-weekend .cal-dnum { color: #c0392b; }
    .cal-today { background: var(--accent-btn); }
    .cal-today .cal-dnum { color: white; font-weight: 700; }
    .cal-today:hover { background: var(--accent-btn); opacity: 0.85; }
    .cal-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent-intent); }
    .cal-today .cal-dot { background: white; }
    .cal-has { font-weight: 700; }
    .timer-container { position: absolute; top: 18%; left: 50%; margin-left: -160px; width: 320px; z-index: 20000; display: none; cursor: grab; user-select: none; }
    .timer-container.show { display: block; }
    .timer-box { width: 100%; display: flex; flex-direction: column; gap: 12px; align-items: center; background: var(--card-bg); backdrop-filter: blur(25px) saturate(160%); -webkit-backdrop-filter: blur(25px) saturate(160%); padding: 24px 32px; border-radius: var(--radius-ios); box-shadow: 0 4px 20px rgba(0,0,0,0.06); border: 1px solid var(--card-border); }
    body.dark-mode .timer-box { background: var(--card-bg); border: 1px solid var(--card-border); box-shadow: 0 15px 40px rgba(0,0,0,0.55); backdrop-filter: blur(25px) saturate(160%); -webkit-backdrop-filter: blur(25px) saturate(160%); }
    .timer-display { font-size: 3.2rem; font-weight: 700; text-align: center; font-variant-numeric: tabular-nums; letter-spacing: 3px; color: var(--accent-wechat); text-shadow: 0 2px 8px rgba(0,0,0,0.1); height: 70px; line-height: 70px; display: block; }
    .timer-box.active .timer-input, .timer-box.active .timer-label, .timer-box.active .timer-separator { display: none; }
    .timer-inputs { display: flex; gap: 8px; justify-content: center; align-items: center; transition: all 0.3s ease; }
    .timer-input-group { display: flex; flex-direction: column; gap: 4px; align-items: center; }
    .timer-input { width: 50px; padding: 8px 6px; text-align: center; font-size: 1rem; font-weight: 700; border: 1.5px solid rgba(0,0,0,0.08); border-radius: var(--radius-xs); background: var(--btn-bg); color: var(--text-main); outline: none; transition: all 0.2s; }
    body.dark-mode .timer-input { background: rgba(38,38,38,0.6); border-color: rgba(255,255,255,0.08); }
    .timer-input:focus { border-color: var(--accent-wechat); box-shadow: 0 0 0 3px rgba(255,255,255,0.7); background: rgba(255,255,255,0.65); }
    .timer-label { font-size: 0.75rem; font-weight: 700; color: var(--text-soft); }
    .timer-separator { font-size: 1.2rem; font-weight: 700; color: var(--text-main); margin-bottom: 12px; }
    .timer-buttons { display: flex; gap: 8px; justify-content: center; transition: all 0.3s ease; }
    .timer-btn { padding: 8px 16px; border: none; border-radius: var(--radius-xs); font-weight: 700; cursor: pointer; font-size: 0.9rem; transition: all 0.2s; }
    .timer-btn-start { background: var(--accent-btn); color: white; box-shadow: 0 4px 12px rgba(255,255,255,0.7); }
    .timer-btn-start:hover { opacity: 0.9; transform: translateY(-2px); }
    .timer-btn-start:active { transform: translateY(0); }
    .timer-btn-reset { background: rgba(0,0,0,0.04); color: var(--text-main); }
    body.dark-mode .timer-btn-reset { background: rgba(255,255,255,0.06); }
    body.dark-mode .icon-simple { background: rgba(38,38,38,0.85); border-color: rgba(255,255,255,0.12); color: #e5e5e5; }
    body.dark-mode .icon-simple:hover { background: rgba(255,255,255,0.2); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    body.dark-mode .goal-chip.goal-met { background: rgba(255,255,255,0.3); color: #2ecc71; }
    body.dark-mode .goal-chip.goal-half { background: rgba(245,124,0,0.12); color: #f0a04b; }
    body.dark-mode .goal-chip.goal-low { background: rgba(74,108,247,0.1); color: #7b9ff5; }
    .timer-btn-reset:hover { background: rgba(0,0,0,0.08); }
    .timer-display.completed { animation: pulse 0.6s ease-in-out; }
    @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
    .notify-bar { position: fixed; top: 0; left: 0; right: 0; background: var(--accent-btn); color: #fff; padding: 12px 20px; font-size: 0.85rem; font-weight: 700; z-index: 10000; transform: translateY(-100%); transition: transform 0.3s ease; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.2); cursor: pointer; }
    .notify-bar.show { transform: translateY(0); }
    .notify-bar .notify-close { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); font-size: 1.1rem; opacity: 0.7; }
    .script-container { position: absolute; left: 20px; top: 80px; display: flex; flex-direction: column; gap: 10px; max-width: 420px; z-index: 1; }
    .script-module { text-align: left; padding: 16px 20px; background: var(--card-bg); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border-radius: var(--radius-ios); border: 1px solid var(--card-border); box-shadow: var(--shadow-card); cursor: grab; user-select: none; position: relative; font-size: 0.92rem; font-weight: 600; color: var(--text-main); line-height: 1.8; letter-spacing: 0.2px; white-space: pre-wrap; word-break: break-word; }
    body.dark-mode .script-module { background: var(--card-bg); border: 1px solid var(--card-border); box-shadow: 0 25px 60px rgba(0,0,0,0.55); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); }
    .learn-container { position: absolute; right: 20px; top: 80px; display: flex; flex-direction: column; gap: 10px; max-width: 460px; z-index: 1; }
    .learn-module { padding: 16px 20px; background: var(--card-bg); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border-radius: var(--radius-ios); border: 1px solid var(--card-border); box-shadow: var(--shadow-card); cursor: grab; user-select: none; position: relative; font-size: 0.85rem; font-weight: 600; color: var(--text-main); line-height: 1.8; letter-spacing: 0.2px; text-align: left; white-space: pre-wrap; word-break: break-word; }
    body.dark-mode .learn-module { background: var(--card-bg); border: 1px solid var(--card-border); box-shadow: 0 25px 60px rgba(0,0,0,0.55); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); }
    .learn-check-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 0.8rem; color: var(--text-soft); font-weight: 700; }
    .learn-check-row input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent-wechat); cursor: pointer; }
    .script-input-modal { max-width: 460px; }
    .script-input-modal textarea { width: 100%; min-height: 100px; background: var(--btn-bg); border: 1px solid var(--card-border); border-radius: var(--radius-xs); padding: 12px 16px; font-size: 0.85rem; color: var(--text-main); outline: none; resize: vertical; font-weight: 600; line-height: 1.6; }
    .script-input-modal textarea:focus { border-color: var(--accent-wechat); }
    .script-list { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
    .script-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--btn-bg); border-radius: var(--radius-xs); border: 1px solid var(--card-border); font-size: 0.78rem; color: var(--text-main); font-weight: 700; }
    .script-item-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px; }
    .app-shell { min-height: 100vh; width: 100%; display: flex; flex-direction: column; position: relative; z-index: 1; }
    .container { flex: 1; display: flex; flex-direction: column; padding: 2px 14px 8px; padding-bottom: calc(8px + env(safe-area-inset-bottom)); }
    .header-bar { display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-shrink: 0; flex-wrap: wrap; margin-bottom: 8px; position: relative; }
    h3 { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.02em; color: var(--text-main); white-space: nowrap; }

    .date-chip { background: var(--card-bg); padding: 4px 12px; border-radius: var(--radius-capsule); font-size: 0.75rem; font-weight: 600; color: var(--text-soft); border: 0.5px solid var(--card-border); }
    .goal-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .goal-chip { background: var(--card-bg); padding: 4px 12px; border-radius: var(--radius-capsule); font-size: 0.75rem; font-weight: 600; border: 0.5px solid var(--card-border); color: var(--text-soft); white-space: nowrap; cursor: default; }
    .goal-actual { cursor: pointer; border-bottom: 1.5px dashed var(--text-light); }
    .goal-actual:hover { color: var(--accent-wechat); border-bottom-color: var(--accent-wechat); }
    .goal-target { cursor: pointer; font-style: italic; font-weight: 600; border-bottom: 1px dotted var(--text-light); }
    .goal-target:hover { color: var(--accent-intent); border-bottom-color: var(--accent-intent); }
    .goal-chip.goal-met { background: rgba(255,255,255,0.55); color: var(--accent-wechat); }
    .goal-chip.goal-half { background: rgba(245,124,0,0.08); color: #e67e22; }
    .goal-chip.goal-low { background: rgba(74,108,247,0.06); color: #4a6cf7; }
    .goal-eye { background: none; border: none; cursor: pointer; font-size: 0.85rem; padding: 2px 4px; opacity: 0.5; transition: opacity 0.2s; line-height: 1; }
    .goal-eye:hover { opacity: 1; }
    .goal-eye.eye-off { opacity: 0.25; }
    .icon-simple { background: rgba(255,255,255,0.92); border: 0.5px solid var(--card-border); color: #191919; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); min-width: 36px; height: 32px; padding: 0 10px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 0.72rem; font-weight: 600; transition: all 0.2s; user-select: none; position: relative; white-space: nowrap; }
    .icon-simple:hover { background: rgba(255,255,255,0.65); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .icon-simple:active { transform: translateY(0px) scale(0.98); }
	    .log-list { max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; font-size: 0.8rem; font-weight: 600; color: var(--text-main); margin-top: 10px; }
	    .log-item { background: var(--btn-bg); padding: 10px 14px; border-radius: var(--radius-xs); border: 1px solid var(--card-border); display: flex; flex-direction: column; gap: 6px; }
	    .log-time { font-size: 0.7rem; color: var(--text-light); }
	    .menu-dropdown { position: absolute; right: 0; top: 100%; margin-top: 8px; background: var(--card-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border-radius: var(--radius-ios); border: 1px solid var(--card-border); box-shadow: 0 12px 32px rgba(0,0,0,0.15); display: none; flex-direction: column; gap: 2px; padding: 6px; z-index: 100; min-width: 168px; }
	    .menu-dropdown.show { display: flex; }
	    .menu-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: transparent; border: none; border-radius: var(--radius-xs); cursor: pointer; font-size: 0.8rem; font-weight: 700; color: var(--text-main); white-space: nowrap; transition: background 0.15s; width: 100%; text-align: left; }
	    .menu-item:hover { background: var(--btn-hover); }
    .two-columns { display: flex; gap: 16px; flex: 1; min-height: 0; }
    .left-area { flex: 1; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .right-area { flex: 2; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .card { background: var(--card-bg); backdrop-filter: blur(25px) saturate(160%); -webkit-backdrop-filter: blur(25px) saturate(160%); border-radius: var(--radius-ios); border: 0.5px solid var(--card-border); box-shadow: var(--shadow-card); padding: 16px 20px; }
    .counter-row { display: flex; gap: 14px; }
    .counter-card { flex: 1; border-radius: var(--radius-md); padding: 12px; border: none; position: relative; overflow: hidden; }
    .counter-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; opacity: 0.4; z-index: 0; border-radius: var(--radius-sm); }
    .wechat-fill { background: rgba(7,193,96,0.55); backdrop-filter: blur(8px) saturate(180%); -webkit-backdrop-filter: blur(8px) saturate(180%); color: white; }
    .wechat-fill::before { background: var(--wechat-gradient); }
    .intent-fill { background: rgba(74,108,247,0.55); backdrop-filter: blur(8px) saturate(180%); -webkit-backdrop-filter: blur(8px) saturate(180%); color: white; }
    .intent-fill::before { background: var(--intent-gradient); }
    .revisit-fill { background: rgba(240,160,75,0.55); backdrop-filter: blur(8px) saturate(180%); -webkit-backdrop-filter: blur(8px) saturate(180%); color: white; }
    .revisit-fill::before { background: var(--revisit-gradient); }
    .visit-fill { background: rgba(56,142,60,0.45); backdrop-filter: blur(8px) saturate(180%); -webkit-backdrop-filter: blur(8px) saturate(180%); color: white; }
    .visit-fill::before { background: var(--visit-gradient); }
    .payment-fill { background: rgba(249,168,37,0.45); backdrop-filter: blur(8px) saturate(180%); -webkit-backdrop-filter: blur(8px) saturate(180%); color: white; }
    .payment-fill::before { background: var(--payment-gradient); }
    .counter-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; position: relative; z-index: 1; }
    .counter-header .button-group { display: flex; gap: 6px; margin-top: 0; }
    .counter-header .circle-btn { width: 28px; height: 28px; font-size: 1.1rem; border-radius: 4px; }
    .counter-label { font-size: 0.8rem; font-weight: 500; color: rgba(255,255,255,0.95); text-shadow: 0 1px 2px rgba(0,0,0,0.1); letter-spacing: -0.01em; }
    .reset-mini { background: rgba(255,255,255,0.3); border: none; font-size: 0.7rem; color: rgba(255,255,255,0.9); cursor: pointer; padding: 4px 8px; border-radius: var(--radius-xs); font-weight: 700; position: relative; z-index: 1; backdrop-filter: blur(4px); }
    .counter-value { font-size: 2.4rem; font-weight: 700; line-height: 1; color: white; text-shadow: 0 2px 4px rgba(0,0,0,0.15); position: relative; z-index: 1; letter-spacing: -0.02em; }
    .counter-stats { display: flex; gap: 12px; margin-top: 6px; position: relative; z-index: 1; font-size: 0.7rem; color: rgba(255,255,255,0.8); font-weight: 600; }
    .counter-stats b { font-weight: 700; }
    .button-group { display: flex; gap: 12px; margin-top: 12px; position: relative; z-index: 1; }
    .circle-btn { width: 40px; height: 40px; border-radius: var(--radius-xs); background: rgba(255,255,255,0.62); border: 1px solid rgba(255,255,255,0.5); font-size: 1.5rem; display: flex; align-items: center; justify-content: center; cursor: pointer; color: white; font-weight: 700; backdrop-filter: blur(4px); transition: 0.2s; }
    .circle-btn:hover { background: rgba(255,255,255,0.65); }
    .btn-special { background: rgba(255,255,255,0.82); }
    .stats-row { display: flex; gap: 10px; }
    .stat-block { flex: 1; text-align: center; border-radius: var(--radius-sm); padding: 10px 4px; border: 1px solid var(--card-border); color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.1); box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
    .stat-wechat { background: rgba(52,211,153,0.4); }
    .stat-intent { background: rgba(255,149,0,0.4); }
    .stat-revisit { background: rgba(74,108,247,0.35); }
    .stat-block .label { font-size: 0.7rem; font-weight: 600; opacity: 0.9; }
    .stat-block .number { font-size: 1.35rem; font-weight: 700; margin-left: 4px; }
    .calendar-compact { padding: 10px 12px; }
    .cal-head { display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 0.8rem; font-weight: 700; color: var(--text-soft); margin-bottom: 8px; }
    .cal-nav-btn { background: none; border: 1px solid var(--card-border); border-radius: var(--radius-xs); cursor: pointer; padding: 2px 8px; font-size: 0.7rem; color: var(--text-soft); transition: all 0.2s; }
    .cal-nav-btn:hover { background: var(--card-bg); color: var(--text-main); }
    .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; text-align: center; }
    .cal-weekday { font-size: 0.72rem; font-weight: 700; color: var(--text-soft); padding: 4px 0; }
    .cal-day { aspect-ratio: 1/1; display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: var(--radius-xs); font-size: 0.76rem; font-weight: 700; color: var(--text-main); background: transparent; cursor: pointer; transition: 0.2s; position: relative; }
    .cal-day:hover { background: var(--cal-hover); transform: scale(0.98); }
    .cal-day.today { background: var(--today-gradient); color: white; box-shadow: 0 0 20px rgba(255,138,101,0.5); text-shadow: 0 1px 2px rgba(0,0,0,0.2); }
    .cal-day.past { background: rgba(128,138,150,0.08); color: var(--text-soft); }
    body.dark-mode .cal-day.past { background: rgba(255,255,255,0.03); }
    .day-number { font-size: 0.86rem; font-weight: 700; }
    .day-badge { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px; font-size: 0.48rem; margin-top: 2px; color: var(--text-soft); font-weight: 700; line-height: 1.2; }
    .cal-day.today .day-badge { color: rgba(255,255,255,0.9); }
    .day-badge span { background: rgba(100,110,130,0.15); padding: 0px 2px; border-radius: var(--radius-xs); }
    .cal-day.today .day-badge span { background: rgba(255,255,255,0.3); }
    .tooltip-simple { position: fixed; background: var(--tooltip-bg); color: var(--tooltip-text); padding: 6px 14px; border-radius: var(--radius-xs); font-size: 0.7rem; pointer-events: none; z-index: 1100; opacity: 0; transition: 0.1s; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.1); font-weight: 600; }
    .tooltip-simple.show { opacity: 1; }
    .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: var(--modal-bg); backdrop-filter: blur(10px); z-index: 2000; display: flex; align-items: center; justify-content: center; visibility: hidden; opacity: 0; transition: 0.2s; }
    .modal-overlay.active { visibility: visible; opacity: 1; }
    .modal-card { background: rgba(255,255,255,0.96); border-radius: var(--radius-ios); width: 1100px; max-width: 98vw; max-height: 90vh; padding: 20px 28px; box-shadow: 0 24px 60px rgba(0,0,0,0.18); border: 0.5px solid var(--card-border); display: flex; flex-direction: column; gap: 16px; color: var(--text-main); }
    body.dark-mode .modal-card { background: rgba(28,28,30,0.97); border-color: var(--card-border); }
    /* 弹窗内表单元素 — 白色实底高对比 */
    .modal-card .input-simple, .modal-card .todo-input { background: #fff; border: 1.5px solid #d0d0d0; color: #111; font-weight: 600; }
    body.dark-mode .modal-card .input-simple, body.dark-mode .modal-card .todo-input { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2); color: #ddd; }
    .modal-card .input-simple:focus, .modal-card .todo-input:focus { border-color: var(--accent-wechat); box-shadow: 0 0 0 3px rgba(16,185,129,0.15); outline: none; }
    .modal-card textarea.input-simple, .modal-card .note-textarea { background: #fff; border: 1.5px solid #d0d0d0; color: #111; }
    body.dark-mode .modal-card textarea.input-simple, body.dark-mode .modal-card .note-textarea { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2); color: #ddd; }
    .modal-card .btn-add, .modal-card .todo-add-btn { font-weight: 700; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; font-weight: 700; font-size: 1.1rem; border-bottom: 0.5px solid var(--separator); padding-bottom: 10px; }
    .modal-header button { background: none; border: none; font-size: 1.2rem; cursor: pointer; color: var(--text-soft); font-weight: 700; }
    .modal-header-meta { display: flex; align-items: center; gap: 14px; }
    .modal-section-title { font-size: 0.78rem; font-weight: 700; color: var(--text-soft); letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .modal-section-title::after { content: ''; flex: 1; height: 1px; background: var(--border-light); }
    .client-modal-list { overflow-y: auto; display: flex; flex-direction: column; gap: 16px; max-height: 75vh; padding-top: 2px; position: relative; }
    /* ===== 意向客户表格 ===== */
    .intent-table { width: 100%; border-collapse: collapse; font-size: 0.83rem; table-layout: auto; }
    .intent-table thead tr { background: linear-gradient(90deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.3) 100%); border-bottom: 2px solid rgba(255,255,255,0.4); }
    body.dark-mode .intent-table thead tr { background: linear-gradient(90deg, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0.15) 100%); }
    .intent-table th { padding: 9px 14px; font-size: 0.72rem; font-weight: 700; color: var(--accent-intent); letter-spacing: 0.4px; text-align: left; white-space: nowrap; }
    .intent-table td { padding: 11px 14px; border-bottom: 1px solid var(--border-light); vertical-align: top; color: var(--text-main); font-weight: 600; }
    .intent-table tbody tr { transition: background 0.15s; }
    .intent-table tbody tr:hover { background: rgba(255,255,255,0.15); }
    body.dark-mode .intent-table tbody tr:hover { background: rgba(90,106,126,0.06); }
    .intent-table tbody tr:last-child td { border-bottom: none; }
    /* 序号/姓名/电话/公司/时间/编辑 — 按内容撑开，不折行 */
    .tbl-seq { font-size: 0.68rem; font-weight: 700; color: var(--text-light); text-align: center; white-space: nowrap; }
    .tbl-name { font-weight: 700; font-size: 0.88rem; white-space: nowrap; }
    .tbl-phone-wrap { display: inline-flex; align-items: center; gap: 5px; font-family: monospace; font-size: 0.8rem; color: var(--text-soft); white-space: nowrap; }
    .tbl-tag { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 0.68rem; font-weight: 600; white-space: nowrap; }
    .tbl-tag-company { background: rgba(255,255,255,0.55); color: var(--accent-wechat); }
    .tbl-tag-fund { background: rgba(255,154,60,0.15); color: #c97a00; }
    body.dark-mode .tbl-tag-fund { color: #d4933a; }
    /* 沟通记录列 — 最大宽度优先，文字完整换行显示 */
    .tbl-note-cell { min-width: 320px; width: 99%; }
    .tbl-note-text { color: var(--text-main); font-size: 0.86rem; font-weight: 600; line-height: 1.7; word-break: break-word; white-space: pre-wrap; text-align: left; }
    .tbl-note-empty { color: var(--text-light); font-size: 0.75rem; font-style: italic; }
    .tbl-time { font-size: 0.7rem; color: var(--text-light); white-space: nowrap; }
    .tbl-action { text-align: center; white-space: nowrap; }
    .edit-note-btn { font-size: 0; background: transparent; border: 1px solid var(--accent-wechat); color: var(--accent-wechat); border-radius: 50%; cursor: pointer; width: 26px; height: 26px; padding: 0; display: inline-flex; justify-content: center; align-items: center; transition: all 0.2s; }
    .edit-note-btn:hover { background: var(--accent-btn); color: #fff; transform: scale(1.1); }
    .tbl-note-edit-wrap { display: flex; flex-direction: column; gap: 6px; }
    .tbl-note-edit-wrap textarea { width: 100%; min-height: 90px; background: var(--btn-bg); border: 1.5px solid var(--accent-wechat); border-radius: 6px; padding: 8px 10px; font-size: 0.86rem; color: var(--text-main); outline: none; font-weight: 600; resize: vertical; line-height: 1.7; }
    .tbl-note-edit-wrap textarea:focus { box-shadow: 0 0 0 3px rgba(255,255,255,0.7); }
    .tbl-note-edit-btns { display: flex; gap: 5px; }
    .tbl-save-btn { font-size: 0.65rem; background: var(--accent-btn); color: #fff; border: none; border-radius: 6px; cursor: pointer; padding: 4px 12px; font-weight: 700; }
    .tbl-cancel-btn { font-size: 0.65rem; background: var(--btn-bg); border: 1px solid var(--card-border); color: var(--text-soft); border-radius: 6px; cursor: pointer; padding: 4px 12px; font-weight: 700; }
    /* ===== 待办卡片（保留原样式） ===== */
    .todo-card-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; background: var(--btn-bg); border-radius: var(--radius-xs); border: 1px solid var(--card-border); font-size: 0.82rem; font-weight: 600; color: var(--text-main); }
    .todo-card-icon { font-size: 1rem; flex-shrink: 0; margin-top: 1px; }
    .todo-card-text { flex: 1; line-height: 1.5; word-break: break-word; }
    .todo-card-time { font-size: 0.68rem; color: var(--text-light); white-space: nowrap; margin-top: 2px; }
    .phone-toggle { background: none; border: none; font-size: 0.8rem; cursor: pointer; opacity: 0.6; transition: opacity 0.2s; padding: 0; outline: none; }
    .phone-toggle:hover { opacity: 1; }
    .empty-clients { text-align: center; color: var(--text-light); padding: 30px 20px; font-size: 0.85rem; font-weight: 700; }
    .card-title { font-weight: 600; font-size: 0.9rem; margin-bottom: 10px; color: var(--text-main); letter-spacing: -0.01em; }
    .register-block { display: flex; flex-direction: column; gap: 5px; }
    .register-block .form-line { gap: 5px; }
    .register-block .input-simple { height: 32px; padding: 0 10px; font-size: 0.8rem; }
    .register-block textarea.input-simple { height: auto; min-height: 52px; padding: 6px 10px; }
    .register-block .btn-add { height: 32px; padding: 0 14px; font-size: 0.8rem; }
    .register-block .detail-toggle-wrap { padding: 2px 0; }
    .register-block .detail-toggle-btn { font-size: 0.68rem; padding: 3px 14px; }
    .register-block .kq-grid { max-height: 150px; font-size: 0.65rem; }
    .register-block .kq-title { font-size: 0.68rem; }
    .register-block .detail-panel { padding: 6px; gap: 5px; }
    .form-line { display: flex; gap: 8px; align-items: center; width: 100%; }
    /* 关键问题勾选 */
    .kq-title { font-size: 0.72rem; font-weight: 700; color: var(--text-soft); margin-bottom: -4px; }
    .kq-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px 10px; font-size: 0.7rem; max-height: 220px; overflow-y: auto; padding: 2px 0; }
    .kq-check { display: flex; align-items: flex-start; gap: 4px; cursor: pointer; padding: 2px 0; color: var(--text-soft); line-height: 1.35; }
    .kq-check input { margin-top: 2px; flex-shrink: 0; accent-color: var(--accent-wechat); }
    body.dark-mode .kq-check { color: #bbb; }
    .kq-tags { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
    .kq-tag { display: inline-block; font-size: 0.62rem; background: rgba(90,106,126,0.08); color: var(--text-soft); padding: 1px 6px; border-radius: 999px; white-space: nowrap; max-width: 180px; overflow: hidden; text-overflow: ellipsis; line-height: 1.5; }
    body.dark-mode .kq-tag { background: rgba(255,255,255,0.06); }
    .input-simple, .todo-input { flex: 1; width: 100%; height: 38px; padding: 0 12px; font-size: 0.85rem; background: var(--btn-bg); border: 0.5px solid var(--card-border); border-radius: var(--radius-sm); color: var(--text-main); outline: none; min-width: 0; font-weight: 400; box-sizing: border-box; transition: all 0.2s; }
    .input-simple:focus, .todo-input:focus { border-color: var(--accent-wechat); box-shadow: 0 0 0 3px rgba(52,211,153,0.15); }
    input::placeholder, textarea::placeholder { font-weight: 400; opacity: 0.6; }
    .input-simple::placeholder, .todo-input::placeholder, .note-textarea::placeholder { font-weight: 400; opacity: 0.6; }
    .auth-input::placeholder { font-weight: 400; opacity: 0.6; }
    .timer-input::placeholder { font-weight: 400; opacity: 0.6; }
    .topbar-search::placeholder { font-weight: 400; opacity: 0.6; }
    textarea.input-simple, .note-textarea { height: auto; min-height: 68px; padding: 10px 12px; resize: vertical; line-height: 1.6; }
    .note-textarea { font-family: inherit; }
    .btn-add, .todo-add-btn { height: 38px; padding: 0 18px; font-size: 0.85rem; font-weight: 600; letter-spacing: -0.01em; border: none; border-radius: var(--radius-xs); color: white; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; transition: all 0.2s; }
    .btn-add { background: var(--accent-btn); }
    .todo-add-btn { background: var(--accent-btn); }
    .btn-add:hover, .todo-add-btn:hover { opacity: 0.92; transform: translateY(-1px); }
    .btn-add:active, .todo-add-btn:active { transform: translateY(0); }
    .btn-add:disabled, .todo-add-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .time-input-compact { flex: 0 0 92px !important; min-width: 92px !important; padding: 0 6px !important; text-align: center; }
    .client-scroll { max-height: 460px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .client-row { background: var(--btn-bg); border-radius: var(--radius-sm); padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; border: 0.5px solid var(--card-border); font-weight: 600; }
    .client-info { flex: 1; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
    .client-name { font-weight: 700; }
    .client-phone, .modal-client-phone { color: var(--text-soft) !important; font-size: 0.75rem; font-weight: 400; text-decoration: none !important; cursor: pointer; }
    .client-phone:hover, .modal-client-phone:hover { text-decoration: underline !important; }
    .phone-toggle { background: none; border: none; font-size: 0.8rem; cursor: pointer; padding: 0 2px; opacity: 0.5; transition: opacity 0.2s; vertical-align: middle; line-height: 1; }
    .phone-toggle:hover { opacity: 1; }
    .client-note { color: var(--text-light); font-size: 0.75rem; font-weight: 400; }
    .del-icon { background: none; border: none; font-size: 0.9rem; color: #c97a7a; cursor: pointer; width: 28px; height: 28px; border-radius: var(--radius-xs); font-weight: 700; }
    .edit-icon { background: none; border: none; font-size: 0; color: var(--accent-wechat); cursor: pointer; width: 28px; height: 28px; border-radius: var(--radius-xs); display: inline-flex; align-items: center; justify-content: center; margin-right: 4px; }
    .export-single-btn { background: none; border: none; font-size: 0; color: var(--accent-intent); cursor: pointer; width: 28px; height: 28px; border-radius: var(--radius-xs); display: inline-flex; align-items: center; justify-content: center; margin-right: 4px; }
    .export-timeline-single-btn { font-size: 0; background: transparent; border: 1px solid var(--accent-intent); color: var(--accent-intent); border-radius: 50%; cursor: pointer; width: 26px; height: 26px; padding: 0; display: inline-flex; justify-content: center; align-items: center; transition: all 0.2s; margin-right: 4px; }
    .export-timeline-single-btn:hover { background: var(--accent-btn); color: #fff; transform: scale(1.1); }
    .client-actions { display: flex; align-items: center; gap: 4px; }
    .todo-list { display: flex; flex-direction: column; gap: 8px; max-height: 200px; overflow-y: auto; }
    .todo-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--btn-bg); border-radius: var(--radius-xs); border: 0.5px solid var(--card-border); font-size: 0.8rem; font-weight: 700; color: var(--text-main); }
    .todo-number { font-weight: 700; color: var(--accent-wechat); min-width: 20px; font-size: 0.85rem; }
    .todo-text { flex: 1; word-break: break-word; line-height: 1.4; }
    .todo-input-row { display: flex; gap: 8px; align-items: center; width: 100%; }
    .todo-del-btn { background: none; border: none; color: #c97a7a; cursor: pointer; font-size: 0.85rem; padding: 0 4px; }
    /* ===== 内容展示模块（复制粘贴保留格式） ===== */
    .paste-card { padding: 0 !important; overflow: hidden; border-radius: var(--radius-ios) !important; position: relative; }
    .paste-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 0.5px solid var(--separator); gap: 8px; }
    .paste-add-btn { min-height: 44px; padding: 0 16px; border-radius: 10px; background: var(--accent-btn); color: #fff; font-weight: 700; font-size: 0.82rem; border: none; cursor: pointer; }
    .paste-add-btn:disabled { opacity: 0.5; }
    .paste-list { display: flex; gap: 8px; overflow-x: auto; padding: 10px 12px; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
    .paste-list::-webkit-scrollbar { display: none; }
    .paste-view { width: 100%; overflow-y: auto; overflow-x: auto; max-height: 70vh; background: var(--card-bg); padding: 16px 18px; box-sizing: border-box; -webkit-overflow-scrolling: touch; font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI Symbol', 'Noto Sans Symbols 2', 'Apple Symbols', sans-serif; }
    /* 防粘贴内容撑破卡片：宽元素压缩、长文本断行、图片自适应 */
    .paste-view * { max-width: 100%; box-sizing: border-box; }
    .paste-view p, .paste-view div, .paste-view li, .paste-view h1, .paste-view h2, .paste-view h3, .paste-view h4, .paste-view span { overflow-wrap: break-word; word-break: break-word; }
    .paste-view img { max-width: 100% !important; height: auto !important; }
    .paste-view img[src^="file:"] { display: none !important; } /* 旧内容兜底：本地路径图片隐藏 */
    .paste-view table { max-width: 100% !important; table-layout: fixed; }
    .paste-view table td, .paste-view table th { word-break: break-all; }
    .paste-empty-state { display: none; flex-direction: column; align-items: center; gap: 8px; padding: 28px 16px; }
    .paste-card.empty .paste-empty-state { display: flex; }
    .paste-card.empty .paste-view { display: none; }
    .paste-empty-label { font-size: 0.8rem; color: var(--text-light); font-weight: 600; }
    .paste-empty-add { min-height: 44px; padding: 0 22px; border-radius: 10px; font-size: 0.82rem; font-weight: 700; color: var(--accent-btn); cursor: pointer; border: 1px solid var(--accent-btn); background: transparent; }
    .paste-empty-add:active { background: var(--btn-bg); }
    /* 编辑器弹窗 */
    .paste-editor { width: 100%; min-height: 200px; max-height: 45vh; overflow-y: auto; padding: 10px 12px; box-sizing: border-box; border: 0.5px solid var(--card-border); border-radius: 10px; background: var(--card-bg); color: var(--text-main); font-size: 0.85rem; line-height: 1.5; outline: none; -webkit-user-select: text; user-select: text; }
    .paste-editor:empty:before { content: attr(data-placeholder); color: var(--text-light); pointer-events: none; }
    .paste-btn-row { display: flex; gap: 8px; justify-content: flex-end; }
    .paste-save-btn { min-height: 44px; padding: 0 20px; border-radius: 10px; background: var(--accent-btn); color: #fff; font-weight: 700; font-size: 0.82rem; border: none; cursor: pointer; }
    .paste-cancel-btn { min-height: 44px; padding: 0 20px; border-radius: 10px; background: var(--btn-bg); color: var(--text-soft); font-weight: 600; font-size: 0.82rem; border: 0.5px solid var(--card-border); cursor: pointer; }
    .paste-loading, .paste-error { padding: 24px 16px; text-align: center; font-size: 0.8rem; color: var(--text-light); }
    .paste-empty-hint { font-size: 0.7rem; color: var(--text-light); font-weight: 500; }
    /* 卡片底部切换栏 */
    /* 沉浸式左右切换箭头：默认隐藏，点击内容/箭头时短暂显示，2.5秒后自动隐藏 */
    .paste-arrow {
      position: absolute; top: 50%; transform: translateY(-50%);
      width: 40px; height: 40px; border-radius: 999px;
      border: 0.5px solid var(--card-border);
      background: var(--modal-bg);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      color: var(--text-main);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; z-index: 5; padding: 0;
      opacity: 0; pointer-events: none;
      transition: opacity 0.25s ease;
      -webkit-tap-highlight-color: transparent; touch-action: manipulation;
    }
    .paste-arrow.show { opacity: 1; pointer-events: auto; }
    .paste-arrow-left { left: 8px; }
    .paste-arrow-right { right: 8px; }
    /* 学习管理内的内容条目列表 */
    .paste-manage-item { display: flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 10px; border-radius: 10px; border: 0.5px solid var(--card-border); background: var(--btn-bg); cursor: pointer; font-size: 0.78rem; font-weight: 600; color: var(--text-main); }
    .paste-manage-item.selected { background: var(--accent-btn); color: #fff; border-color: transparent; }
    .paste-manage-item .paste-manage-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .paste-manage-del { width: 32px; height: 32px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; border: none; background: transparent; color: inherit; font-size: 0.8rem; cursor: pointer; border-radius: 8px; opacity: 0.7; }
    .paste-manage-del:active { opacity: 1; }
    .paste-manage-empty { font-size: 0.72rem; color: var(--text-light); padding: 8px 4px; font-weight: 500; }
    @media (max-width: 760px) { .paste-card { order: 999; } }
    @media (min-width: 761px) {
      .right-area { order: 2; } .left-area { order: 1; }
      .card { padding: 14px 16px; }
      .counter-card { padding: 16px 14px; }
      .counter-label { font-size: 0.85rem; }
      .counter-value { font-size: 3.2rem; font-weight: 700; }
      .circle-btn { width: 42px; height: 42px; font-size: 1.5rem; }
      .button-group { gap: 12px; margin-top: 14px; }
      .reset-mini { font-size: 0.75rem; }
      .client-scroll { max-height: 320px; }
      .todo-list { max-height: 180px; }
      .card-title { font-size: 0.85rem; margin-bottom: 8px; }
      .input-simple, .todo-input { height: 34px; padding: 0 10px; font-size: 0.8rem; }
      .btn-add, .todo-add-btn { height: 34px; padding: 0 14px; font-size: 0.8rem; }
      .time-input-compact { flex: 0 0 84px !important; min-width: 84px !important; padding: 0 4px !important; }
      .client-row { padding: 8px 12px; font-size: 0.8rem; }
      .todo-item { padding: 6px 10px; font-size: 0.8rem; }
      /* PC/desktop monthly calendar font size increases and bottom alignment */
      .calendar-compact { flex: 1; display: flex; flex-direction: column; }
      .cal-head { font-size: 0.95rem; margin-bottom: 12px; }
      .cal-grid { flex: 1; align-content: space-around; }
      .cal-weekday { font-size: 0.86rem; padding: 6px 0; }
      .cal-day { font-size: 0.88rem; }
      .day-number { font-size: 1.02rem; }
      .day-badge { font-size: 0.66rem; margin-top: 4px; gap: 3px; }
      .day-badge span { padding: 1px 4px; }
    }
    @media (min-width: 1024px) {
      .right-area {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      /* PC: compact all modules */
      .container { padding: 2px 12px 6px; }
      .two-columns { gap: 12px; }
      .left-area { gap: 10px; flex: 0.85; }
      .right-area { gap: 12px; }
      .card { padding: 12px 16px; }
      .card-title { font-size: 0.78rem; margin-bottom: 4px; }
      h3 { font-size: 1.1rem; }
      .header-bar { margin-bottom: 4px; gap: 4px; }
      /* Counter cards */
      .counter-row { gap: 10px; }
      .counter-card { padding: 10px; }
      .counter-value { font-size: 1.8rem; }
      .counter-label { font-size: 0.7rem; }
      .counter-stats { font-size: 0.62rem; gap: 8px; }
      .counter-header .circle-btn { width: 26px; height: 26px; font-size: 1rem; border-radius: 4px; }
      .counter-header .button-group { gap: 4px; }
      .circle-btn { width: 34px; height: 34px; font-size: 1.2rem; border-radius: 7px; }
      .reset-mini { font-size: 0.6rem; padding: 2px 6px; }
      .stats-row { gap: 8px; }
      .stat-block { padding: 4px 2px; gap: 1px; }
      .stat-block .label { font-size: 0.6rem; }
      .stat-block .number { font-size: 1rem; }
      /* Form inputs */
      .input-simple { padding: 6px 10px; font-size: 0.75rem; }
      .form-line { gap: 6px; }
      .register-block { gap: 8px; }
      .btn-add { padding: 6px 14px; font-size: 0.78rem; }
      /* Client cards */
      .client-card-item { padding: 8px 12px; margin-bottom: 8px; }
      .client-card-name { font-size: 0.82rem; }
      .client-card-time { font-size: 0.62rem; }
      .client-card-text { font-size: 0.68rem; }
      .client-card-label { font-size: 0.6rem; }
      /* Calendar */
      .cal-day { min-height: 36px; padding: 3px 1px; }
      .day-number { font-size: 0.72rem; }
      .day-badge { font-size: 0.44rem; gap: 1px; }
      .cal-grid { gap: 1px; }
      /* Todo */
      .todo-item-clean { padding: 4px 2px; font-size: 0.72rem; gap: 6px; }
      .todo-tab-btn { padding: 2px 10px; font-size: 0.7rem; }
      .todo-add-btn { padding: 4px 10px; font-size: 0.7rem; }
      .todo-input { padding: 4px 8px; font-size: 0.72rem; }
      /* Others */
      .icon-simple { min-width: 28px; height: 28px; font-size: 0.65rem; padding: 0 8px; }
      .date-chip { font-size: 0.7rem; padding: 3px 10px; }
      .goal-chip { font-size: 0.7rem; padding: 3px 10px; }
      .journal-card { padding: 10px 16px; gap: 8px; }
      .journal-editor { padding: 12px 16px; gap: 8px; }
      .journal-editor textarea { min-height: 80px; font-size: 0.85rem; padding: 8px; }
      .journal-main { padding: 6px 20px 20px; gap: 14px; }
      .sidebar { width: 150px; padding: 8px 6px; }
      .sidebar-item { padding: 8px 12px; font-size: 0.82rem; }
      .topbar { height: 38px; padding: 0 16px; gap: 12px; }
      .topbar-search { max-width: 280px; padding: 6px 12px; font-size: 0.8rem; }
      .topbar-btn { padding: 6px 14px; font-size: 0.8rem; }
      /* Modal */
      .modal-card { padding: 16px 22px; gap: 12px; }
      .intent-table { font-size: 0.72rem; }
      .intent-table th, .intent-table td { padding: 7px 10px; }
      /* Temp card */
      .temp-card { padding: 8px 10px; }
      .temp-card-row { gap: 6px; font-size: 0.7rem; }
      .temp-card-name { font-size: 0.78rem; }
    }
    @media (max-width: 760px) {
      .timer-container { display: none !important; }
      .timer-box { padding: 16px 20px; }
      .timer-display { font-size: 2.5rem; }
      .two-columns { flex-direction: column; gap: 20px; flex: none; }
      .left-area, .right-area { flex: none; width: 100%; }
      .right-area { order: 1; } .left-area { order: 2; }
      .container { padding: 6px 10px 6px; }
      .header-bar { margin-bottom: 6px; gap: 5px; }
      h3 { font-size: 1.15rem; }
      .modal-card { padding: 16px 14px; gap: 12px; }
      .client-modal-list { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .pin-box { min-width: 280px; max-width: 88vw; padding: 24px 18px; gap: 12px; top: 50%; transform: translate(-50%, -50%); }
      .pin-stats { gap: 8px; }
      .pin-stat-item { padding: 10px 10px; min-width: 90px; gap: 4px; }
      .pin-stat-label { font-size: 0.75rem; }
      .pin-stat-value { font-size: 1.8rem; }
      .pin-input { width: 182px; padding: 10px 17px; font-size: 1.26rem; }
      .pin-btn { padding: 7px 18px; font-size: 0.85rem; }
      .script-container { display: none !important; }
      .learn-container { right: 8px; top: 60px; max-width: 52vw; max-height: 25vh; overflow-y: auto; }
      .script-module { padding: 8px 12px; font-size: 0.72rem; text-align: left; font-weight: 600; line-height: 1.6; }
      .learn-module { padding: 8px 12px; font-size: 0.7rem; }

      .card { padding: 12px 14px; border-radius: 10px; }
      .card-title { font-size: 0.82rem; margin-bottom: 6px; }
      .counter-row { gap: 8px; }
      .counter-card { padding: 8px; }
      .counter-value { font-size: 1.6rem; }
      .counter-header .circle-btn { width: 24px; height: 24px; font-size: 0.9rem; border-radius: 3px; }
      .counter-header .button-group { gap: 4px; }
      .counter-stats { font-size: 0.6rem; gap: 8px; }
      .button-group { gap: 6px; margin-top: 6px; justify-content: center; }
      .circle-btn { width: 30px; height: 30px; font-size: 1.1rem; border-radius: 6px; }
      .reset-mini { padding: 2px 4px; font-size: 0.6rem; }
      .stats-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .stat-block { padding: 6px 2px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
      .stat-block .label { font-size: 0.62rem; }
      .stat-block .number { font-size: 1rem; margin-left: 0; }
      .cal-day { aspect-ratio: auto; min-height: 38px; padding: 3px 1px; overflow: hidden; }
      .cal-grid { gap: 2px; }
      .day-badge { font-size: 0.44rem; gap: 1px; }
      .day-number { font-size: 0.75rem; }
      .todo-input-row { flex-wrap: wrap; gap: 8px; }
      .todo-input { flex: 1 1 100%; }
      .time-input-compact { flex: 1 !important; min-width: 0 !important; }
      .todo-add-btn { flex: 1; }
      .client-actions { flex-shrink: 0; }
      .icon-simple { min-width: 28px; height: 28px; font-size: 0.68rem; padding: 0 6px; }
      #logBtn { height: 32px !important; padding: 0 8px !important; font-size: 0.72rem !important; }
      .intent-table { font-size: 0.75rem; }
      .intent-table th, .intent-table td { padding: 8px 6px; }
      .tbl-note-cell { min-width: 200px; }

      /* Mobile: 全量客户弹窗卡片适配 */
      #allClientsModal .modal-card { max-height: 93vh !important; max-width: 100vw !important; margin-top: 7vh !important; border-radius: 16px 16px 0 0 !important; }
      /* Mobile: 临时表底部抽屉 */
      #tempFullModal .modal-card { max-height: 93vh !important; max-width: 100vw !important; margin-top: 7vh !important; border-radius: 16px 16px 0 0 !important; width: 100vw !important; }
      #allClientsModal .modal-header { flex-wrap: wrap; gap: 6px; padding-bottom: 6px; font-size: 0.85rem; }
      #allClientsModal .modal-header > div { flex-wrap: wrap; gap: 4px; }
      #allClientsModal .modal-header > div > span { font-size: 0.85rem; }
      #allClientsModal .modal-header .btn-add { font-size: 0.68rem !important; padding: 2px 8px !important; height: 26px !important; }
      #allClientsModal .modal-header .search-input { width: 110px !important; height: 26px !important; font-size: 0.68rem !important; }
      #allClientsModal .modal-header select { height: 26px !important; font-size: 0.65rem !important; padding: 0 2px !important; }
      #allClientsModal #allClientsSortOrderBtn { height: 26px !important; width: 26px !important; font-size: 0.75rem !important; }
      .all-client-card .card-action-btn { font-size: 0.7rem !important; padding: 4px 10px !important; }
    }
    /* ===== 紧凑表格与待办行样式 ===== */
    .table-compact { width: 100%; border-collapse: collapse; font-size: 0.78rem; color: var(--text-main); text-align: left; }
    .table-compact th { padding: 4px 6px; font-weight: 700; color: var(--text-soft); border-bottom: 0.5px solid var(--card-border); font-size: 0.72rem; }
    .table-compact td { padding: 6px 6px; border-bottom: 0.5px solid var(--card-border); vertical-align: middle; font-weight: 600; }
    .table-compact tr:last-child td { border-bottom: none; }
    .table-compact tr:hover { background: var(--btn-hover); }
    .client-detail { color: var(--text-light); font-size: 0.72rem; }
    .client-note-text { color: var(--text-soft); font-size: 0.75rem; word-break: break-word; }
    .client-time-text { color: var(--text-light); font-size: 0.7rem; }
    
    .todo-item-clean { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 0.5px solid var(--card-border); font-size: 0.78rem; font-weight: 700; color: var(--text-main); transition: background 0.15s; }
    .todo-item-clean:hover { background: var(--btn-hover); }
    .todo-item-clean:last-child { border-bottom: none; }
    .todo-number-clean { font-weight: 800; color: var(--accent-wechat); font-size: 0.78rem; min-width: 16px; }
    .todo-text-clean { flex: 1; word-break: break-word; line-height: 1.4; }
    .todo-del-btn-clean { background: none; border: none; color: #c97a7a; cursor: pointer; font-size: 0.8rem; padding: 0 4px; opacity: 0.5; transition: opacity 0.2s; }
    .todo-del-btn-clean:hover { opacity: 1; }
    .todo-time-tag { background: var(--card-border); color: var(--text-soft); padding: 1px 4px; border-radius: 4px; font-size: 0.65rem; margin-left: 6px; font-weight: 700; }
    .todo-tab-switch { display: inline-flex; background: var(--btn-bg); border-radius: var(--radius-xs); padding: 2px; gap: 2px; }
    .todo-tab-btn { padding: 3px 14px; font-size: 0.75rem; font-weight: 700; border: none; border-radius: 4px; cursor: pointer; background: transparent; color: var(--text-soft); transition: all 0.2s; }
    .todo-tab-btn.active { background: var(--accent-btn); color: white; }
    .todo-tab-btn:not(.active):hover { color: var(--text-main); }

    /* ===== 客户端卡片排版样式 ===== */
    .client-card-item {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-sm);
      padding: 12px 14px;
      margin-bottom: 12px;
      box-shadow: var(--shadow-card);
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      gap: 10px;
      position: relative;
    }
    .client-card-item:hover {
      border-color: rgba(7, 193, 96, 0.4);
      box-shadow: 0 6px 16px rgba(0,0,0,0.06);
      transform: translateY(-1px);
    }
    body.dark-mode .client-card-item:hover {
      border-color: rgba(7, 193, 96, 0.5);
      box-shadow: 0 6px 16px rgba(0,0,0,0.25);
    }
    .client-card-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .client-card-primary {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .client-card-name {
      font-size: 0.88rem;
      font-weight: 600;
      color: var(--text-main);
    }
    .client-card-phone-wrap {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--btn-bg);
      padding: 2px 8px;
      border-radius: 12px;
    }
    .client-card-phone {
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--accent-intent);
      text-decoration: none;
    }
    .client-card-time {
      font-size: 0.72rem;
      color: var(--text-light);
      font-weight: 400;
    }
    .client-card-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .client-card-date-badge {
      font-size: 0.68rem;
      font-weight: 600;
      color: var(--accent-intent);
      background: var(--accent-intent-bg);
      padding: 2px 8px;
      border-radius: 10px;
      white-space: nowrap;
    }
    .client-card-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .client-card-tag {
      font-size: 0.72rem;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: var(--radius-xs);
    }
    .client-card-tag-company {
      background: var(--accent-intent-bg);
      color: var(--accent-intent);
      border: 0.5px solid rgba(7, 193, 96, 0.2);
    }
    .client-card-tag-bank {
      font-size: 0.7rem;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: var(--radius-xs);
      border: 0.5px solid rgba(90,106,126,0.3);
    }
    .client-card-tag-fund {
      background: rgba(255, 183, 77, 0.1);
      color: #e67e22;
      border: 0.5px solid rgba(255, 183, 77, 0.2);
    }
    body.dark-mode .client-card-tag-fund {
      background: rgba(230, 126, 34, 0.15);
      color: #f39c12;
    }
    /* Detail info tags */
    .client-card-tag-detail {
      background: rgba(52, 152, 219, 0.08);
      color: #2980b9;
      border: 0.5px solid rgba(52, 152, 219, 0.15);
      font-size: 0.68rem;
    }
    body.dark-mode .client-card-tag-detail {
      background: rgba(52, 152, 219, 0.12);
      color: #5dade2;
    }
    /* Customer grade label tags */
    .client-card-tag-grade-a {
      background: rgba(39, 174, 96, 0.12);
      color: #1e8449;
      border: 0.5px solid rgba(39, 174, 96, 0.3);
      font-size: 0.75rem;
    }
    body.dark-mode .client-card-tag-grade-a {
      background: rgba(39, 174, 96, 0.18);
      color: #2ecc71;
    }
    .client-card-tag-grade-b {
      background: rgba(52, 152, 219, 0.12);
      color: #2471a3;
      border: 0.5px solid rgba(52, 152, 219, 0.3);
      font-size: 0.75rem;
    }
    body.dark-mode .client-card-tag-grade-b {
      background: rgba(52, 152, 219, 0.18);
      color: #5dade2;
    }
    .client-card-tag-grade-c {
      background: rgba(149, 165, 166, 0.12);
      color: #7f8c8d;
      border: 0.5px solid rgba(149, 165, 166, 0.3);
      font-size: 0.75rem;
    }
    body.dark-mode .client-card-tag-grade-c {
      background: rgba(149, 165, 166, 0.18);
      color: #bdc3c7;
    }
    /* No-revisit warning tags */
    .client-card-tag-no-revisit-5 {
      background: rgba(230, 126, 34, 0.1);
      color: #d35400;
      border: 0.5px solid rgba(230, 126, 34, 0.2);
    }
    body.dark-mode .client-card-tag-no-revisit-5 {
      background: rgba(230, 126, 34, 0.15);
      color: #f39c12;
    }
    .client-card-tag-no-revisit-10 {
      background: rgba(231, 76, 60, 0.1);
      color: #c0392b;
      border: 0.5px solid rgba(231, 76, 60, 0.2);
    }
    body.dark-mode .client-card-tag-no-revisit-10 {
      background: rgba(231, 76, 60, 0.15);
      color: #e74c3c;
    }
    /* Collapsible detail panel */
    .detail-toggle-wrap {
      display: flex;
      justify-content: center;
      padding: 4px 0;
    }
    .detail-toggle-btn {
      background: none;
      border: none;
      border-top: 0.5px solid var(--separator);
      padding: 6px 20px;
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--accent-wechat);
      cursor: pointer;
      width: 100%;
      letter-spacing: 0.5px;
      transition: opacity 0.2s;
    }
    .detail-toggle-btn:hover { opacity: 0.7; }
    .detail-toggle-icon {
      display: inline-block;
      transition: transform 0.25s ease;
      margin-right: 4px;
      font-size: 0.6rem;
    }
    .detail-toggle-icon.open { transform: rotate(90deg); }
    .detail-panel {
      border: 0.5px solid var(--card-border);
      border-radius: var(--radius-sm);
      padding: 8px;
      margin: 2px 0;
      background: rgba(0,0,0,0.012);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    body.dark-mode .detail-panel {
      background: rgba(255,255,255,0.015);
    }
    .status-conditional-area { display: none; flex-direction: column; gap: 8px; padding: 4px 0; }
    .status-conditional-area.visible { display: flex; }
    .status-field-separator { font-size: 0.65rem; font-weight: 600; color: var(--text-light); padding: 4px 0 2px 0; border-top: 0.5px solid var(--separator); margin-top: 2px; }
    .input-select {
      appearance: auto;
      -webkit-appearance: auto;
      background: var(--card-bg);
      color: var(--text-main);
      cursor: pointer;
      height: 38px;
    }
    .client-card-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: rgba(0,0,0,0.015);
      padding: 8px;
      border-radius: 6px;
      border: 0.5px solid var(--border-light);
    }
    body.dark-mode .client-card-body {
      background: rgba(255,255,255,0.01);
    }
    .client-card-content-block {
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 0.78rem;
      border-left: 2px solid var(--border-light);
      padding-left: 8px;
    }
    .client-card-content-block.follow-up {
      border-left-color: var(--accent-wechat);
    }
    .client-card-label {
      font-size: 0.65rem;
      font-weight: 600;
      color: var(--text-light);
      letter-spacing: 0.5px;
    }
    .client-card-text {
      color: var(--text-soft);
      font-weight: 600;
      line-height: 1.45;
      word-break: break-all;
    }
    /* Status marker — card level */
    .client-card-item.status-success {
      border: 1px solid rgba(39,174,96,0.35);
      border-left: 5px solid #27ae60;
      border-top: 3px solid #27ae60;
      background: linear-gradient(135deg, rgba(39,174,96,0.14) 0%, rgba(39,174,96,0.05) 50%, var(--card-bg) 100%);
      box-shadow: 0 2px 10px rgba(39,174,96,0.18);
    }
    .client-card-item.status-failed {
      border: 1px solid rgba(230,126,34,0.35);
      border-left: 5px solid #e67e22;
      border-top: 3px solid #e67e22;
      background: linear-gradient(135deg, rgba(230,126,34,0.14) 0%, rgba(230,126,34,0.05) 50%, var(--card-bg) 100%);
      box-shadow: 0 2px 10px rgba(230,126,34,0.18);
    }
    .client-card-item.status-success:hover {
      border-color: rgba(39,174,96,0.55);
      box-shadow: 0 4px 16px rgba(39,174,96,0.25);
    }
    .client-card-item.status-failed:hover {
      border-color: rgba(230,126,34,0.55);
      box-shadow: 0 4px 16px rgba(230,126,34,0.25);
    }
    body.dark-mode .client-card-item.status-success {
      border-color: rgba(39,174,96,0.4);
      background: linear-gradient(135deg, rgba(39,174,96,0.18) 0%, rgba(39,174,96,0.06) 50%, var(--card-bg) 100%);
      box-shadow: 0 2px 12px rgba(39,174,96,0.22);
    }
    body.dark-mode .client-card-item.status-failed {
      border-color: rgba(230,126,34,0.4);
      background: linear-gradient(135deg, rgba(230,126,34,0.18) 0%, rgba(230,126,34,0.06) 50%, var(--card-bg) 100%);
      box-shadow: 0 2px 12px rgba(230,126,34,0.22);
    }
    /* Status badge inside card */
    .client-card-status-badge {
      display: inline-block;
      font-size: 0.7rem;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 10px;
      letter-spacing: 0.4px;
      white-space: nowrap;
      align-self: flex-start;
    }
    .client-card-status-badge.status-badge-success {
      background: linear-gradient(135deg, #27ae60, #2ecc71);
      color: #fff;
      box-shadow: 0 2px 6px rgba(39,174,96,0.35);
    }
    .client-card-status-badge.status-badge-failed {
      background: linear-gradient(135deg, #e67e22, #f39c12);
      color: #fff;
      box-shadow: 0 2px 6px rgba(230,126,34,0.35);
    }
    body.dark-mode .client-card-status-badge.status-badge-success {
      background: linear-gradient(135deg, #1e8449, #27ae60);
      box-shadow: 0 2px 8px rgba(39,174,96,0.4);
    }
    body.dark-mode .client-card-status-badge.status-badge-failed {
      background: linear-gradient(135deg, #c0651f, #e67e22);
      box-shadow: 0 2px 8px rgba(230,126,34,0.4);
    }
    /* Status toggle button */
    .status-toggle-btn {
      width: 32px;
      height: 32px;
      font-size: 0.85rem;
      font-weight: 600;
      border-radius: var(--radius-sm);
      border: none;
      background: none;
      color: var(--text-soft);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .status-toggle-btn:hover { opacity: 0.75; }
    .status-toggle-btn svg, .client-card-actions-top .card-action-btn svg { display: block; }
    .status-toggle-btn.status-success {
      background: rgba(39,174,96,0.12);
      color: #27ae60;
    }
    .status-toggle-btn.status-failed {
      background: rgba(230,126,34,0.12);
      color: #e67e22;
    }
    body.dark-mode .status-toggle-btn.status-success {
      background: rgba(39,174,96,0.16);
      color: #2ecc71;
    }
    body.dark-mode .status-toggle-btn.status-failed {
      background: rgba(230,126,34,0.16);
      color: #f0a04b;
    }
    .flag-dot{width:12px;height:12px;border-radius:50%;border:2px solid #e74c3c;background:transparent;cursor:pointer;padding:0;margin:0;flex-shrink:0;transition:all .15s;touch-action:manipulation;min-width:12px}
    .flag-dot-active{background:#e74c3c;box-shadow:0 0 3px rgba(231,76,60,0.5)}
    body.dark-mode .flag-dot-active{box-shadow:0 0 4px rgba(231,76,60,0.7)}
    .all-clients-stats{display:flex;gap:8px;padding:10px 16px;margin:0 -4px;background:var(--card-bg);border-bottom:1px solid var(--border-light);flex-wrap:wrap;position:sticky;top:0;z-index:5}
    .all-clients-stats .stats-item{font-size:0.72rem;font-weight:600;color:var(--text-soft);padding:4px 12px;border-radius:12px;background:var(--btn-bg);white-space:nowrap}
    .all-clients-stats .stats-item strong{font-weight:900;font-size:0.85rem;margin-left:2px}
    .all-clients-stats .stats-total strong{color:var(--accent-wechat)}
    .all-clients-stats .stats-unmarked strong{color:var(--text-soft)}
    .all-clients-stats .stats-success strong{color:#27ae60}
    .all-clients-stats .stats-failed strong{color:#e67e22}
    body.dark-mode .all-clients-stats .stats-success strong{color:#2ecc71}
    body.dark-mode .all-clients-stats .stats-failed strong{color:#f0a04b}
    /* ===== 意向客户全量表 + 临时登记表：强制浅色模式（即使全局深色，方便阅读与编辑） ===== */
    body.dark-mode #allClientsModal,
    body.dark-mode #tempFullModal {
      color-scheme: light;
      --card-bg: rgba(255,255,255,0.80);
      --card-border: rgba(0,0,0,0.04);
      --separator: rgba(0,0,0,0.08);
      --text-main: #1c1c1e;
      --text-soft: #3a3a3c;
      --text-light: #5c5c60;
      --accent-intent: #FB8C00;
      --accent-wechat-bg: #ECFDF5;
      --accent-intent-bg: #FFF8F0;
      --accent-btn: rgba(52,211,153,0.75);
      --btn-bg: rgba(255,255,255,0.92);
      --btn-hover: #e5e5e5;
      --border-light: #eaeaeb;
      --modal-card: rgba(255,255,255,0.55);
      --shadow-card: 0 2px 12px rgba(0,0,0,0.06);
      --cal-hover: #f2f2f7;
      --wechat-gradient: linear-gradient(135deg, #C8F5D8 0%, #7EE8A0 50%, #34D399 100%);
      --intent-gradient: linear-gradient(135deg, #FFE8C0 0%, #FFC870 50%, #FF9500 100%);
      --today-gradient: linear-gradient(135deg, #ffe0cc 0%, #ffab7a 50%, #ff7744 100%);
    }
    body.dark-mode #allClientsModal .modal-card,
    body.dark-mode #tempFullModal .modal-card { background: rgba(255,255,255,0.96); }
    body.dark-mode #allClientsModal .modal-card .input-simple,
    body.dark-mode #tempFullModal .modal-card .input-simple { background: #fff; border: 1.5px solid #d0d0d0; color: #111; }
    body.dark-mode #allClientsModal .modal-card textarea.input-simple,
    body.dark-mode #tempFullModal .modal-card textarea.input-simple { background: #fff; border: 1.5px solid #d0d0d0; color: #111; }
    body.dark-mode #allClientsModal .client-card-item:hover { border-color: rgba(7,193,96,0.4); box-shadow: 0 6px 16px rgba(0,0,0,0.06); }
    body.dark-mode #allClientsModal .client-card-tag-fund,
    body.dark-mode #tempFullModal .client-card-tag-fund { background: rgba(255,183,77,0.1); color: #e67e22; }
    body.dark-mode #allClientsModal .client-card-tag-detail { background: rgba(52,152,219,0.08); color: #2980b9; }
    body.dark-mode #allClientsModal .client-card-tag-grade-a { background: rgba(39,174,96,0.12); color: #1e8449; }
    body.dark-mode #allClientsModal .client-card-tag-grade-b { background: rgba(52,152,219,0.12); color: #2471a3; }
    body.dark-mode #allClientsModal .client-card-tag-grade-c { background: rgba(149,165,166,0.12); color: #7f8c8d; }
    body.dark-mode #allClientsModal .client-card-tag-no-revisit-5 { background: rgba(230,126,34,0.1); color: #d35400; }
    body.dark-mode #allClientsModal .client-card-tag-no-revisit-10 { background: rgba(231,76,60,0.1); color: #c0392b; }
    body.dark-mode #allClientsModal .detail-panel { background: rgba(0,0,0,0.012); }
    body.dark-mode #allClientsModal .client-card-body { background: rgba(0,0,0,0.015); }
    body.dark-mode #allClientsModal .client-card-item.status-success { border: 1px solid rgba(39,174,96,0.35); border-left: 5px solid #27ae60; border-top: 3px solid #27ae60; background: linear-gradient(135deg, rgba(39,174,96,0.14) 0%, rgba(39,174,96,0.05) 50%, var(--card-bg) 100%); box-shadow: 0 2px 10px rgba(39,174,96,0.18); }
    body.dark-mode #allClientsModal .client-card-item.status-failed { border: 1px solid rgba(230,126,34,0.35); border-left: 5px solid #e67e22; border-top: 3px solid #e67e22; background: linear-gradient(135deg, rgba(230,126,34,0.14) 0%, rgba(230,126,34,0.05) 50%, var(--card-bg) 100%); box-shadow: 0 2px 10px rgba(230,126,34,0.18); }
    body.dark-mode #allClientsModal .client-card-status-badge.status-badge-success { background: linear-gradient(135deg, #27ae60, #2ecc71); box-shadow: 0 2px 6px rgba(39,174,96,0.35); }
    body.dark-mode #allClientsModal .client-card-status-badge.status-badge-failed { background: linear-gradient(135deg, #e67e22, #f39c12); box-shadow: 0 2px 6px rgba(230,126,34,0.35); }
    body.dark-mode #allClientsModal .status-toggle-btn.status-success { background: rgba(39,174,96,0.12); color: #27ae60; }
    body.dark-mode #allClientsModal .status-toggle-btn.status-failed { background: rgba(230,126,34,0.12); color: #e67e22; }
    body.dark-mode #allClientsModal .flag-dot-active { box-shadow: 0 0 3px rgba(231,76,60,0.5); }
    body.dark-mode #allClientsModal .all-clients-stats .stats-success strong { color: #27ae60; }
    body.dark-mode #allClientsModal .all-clients-stats .stats-failed strong { color: #e67e22; }
    body.dark-mode #tempFullModal .kq-tag { background: rgba(90,106,126,0.08); }
    .follow-up-list{display:flex;flex-direction:column;gap:6px}
    .follow-up-record{background:var(--btn-bg);border-radius:8px;padding:8px 10px;border-left:3px solid var(--accent-wechat)}
    .follow-up-record-header{font-size:0.68rem;font-weight:800;color:var(--accent-wechat);margin-bottom:3px}
    .follow-up-record-text{font-size:0.78rem;font-weight:600;color:var(--text-main);line-height:1.4;word-break:break-all}
    .follow-up-add-btn{font-size:0.7rem;font-weight:700;padding:5px 12px;border:1px dashed var(--accent-wechat);color:var(--accent-wechat);background:transparent;border-radius:6px;cursor:pointer;transition:all .15s;margin-top:4px}
    .follow-up-add-btn:hover{background:rgba(255,255,255,0.3)}
    .follow-up-edit-row{display:flex;gap:8px;align-items:flex-start}
    .follow-up-remove-btn{font-size:0.8rem;background:none;border:none;color:#e74c3c;cursor:pointer;font-weight:700;padding:4px 6px}
    .client-card-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 4px;
      border-top: 1px dashed var(--border-light);
      padding-top: 8px;
    }
    .client-card-actions-top {
      position: absolute;
      top: 8px;
      right: 10px;
      display: flex;
      align-items: center;
      gap: 4px;
      z-index: 2;
    }
    .client-card-actions-top .card-action-btn {
      width: 32px;
      height: 32px;
      font-size: 0.8rem;
      font-weight: 600;
      padding: 0;
      border: none;
      background: none;
      color: var(--text-soft);
      cursor: pointer;
      border-radius: var(--radius-xs);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 1;
      transition: opacity 0.15s;
    }
    .all-client-card:hover .client-card-actions-top .card-action-btn {
      opacity: 1;
    }




    /* ===== 临时登记全量表 ===== */
    .temp-full-table { width:100%; border-collapse:collapse; font-size:0.75rem; table-layout:fixed; }
    .temp-full-table th { position:sticky; top:0; background:var(--card-bg); z-index:1; text-align:left; padding:8px 6px; font-weight:700; font-size:0.7rem; color:var(--text-soft); border-bottom:2px solid var(--card-border); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .temp-full-table td { padding:6px 6px; border-bottom:1px solid var(--border-light); color:var(--text-main); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .temp-full-table .col-date { width:86px; white-space:nowrap; }
    .temp-full-table .col-time { width:68px; white-space:nowrap; }
    .temp-full-table .col-name { width:68px; }
    .temp-full-table .col-phone { width:108px; }
    .temp-full-table .col-company { width:96px; }
    .temp-full-table .col-fund { width:72px; }
    .temp-full-table td.note-cell { white-space:normal; word-break:break-all; }
    .temp-full-table .col-act { width:76px; }
    .temp-full-table tbody tr:hover { background:var(--btn-bg); }
    .temp-tbl-del { background:none; border:none; color:#e74c3c; cursor:pointer; padding:0 4px; font-weight:700; }
    .temp-tbl-edit { background:none; border:none; color:var(--text-soft); cursor:pointer; padding:0 4px; font-weight:700; }
    .temp-tbl-convert { background:none; border:none; color:var(--accent-intent); cursor:pointer; font-size:0.85rem; padding:0 4px; margin-right:4px; font-weight:700; }
    .temp-full-table .temp-tbl-del { font-size:0.85rem; }
    .temp-full-table .temp-tbl-convert { font-size:0.85rem; }
    .temp-card-list { display:none; flex-direction:column; gap:8px; padding:8px; }
    .temp-card { background:var(--card-bg); border:1px solid var(--card-border); border-radius:8px; padding:10px 12px; }
    .temp-card-row { display:flex; align-items:center; gap:8px; font-size:0.72rem; margin-bottom:4px; }
    .temp-card-row:last-child { margin-bottom:0; }
    .temp-card-date { color:var(--text-soft); font-weight:700; font-size:0.68rem; white-space:nowrap; }
    .temp-card-time { color:var(--text-light); font-size:0.68rem; }
    .temp-card-name { font-weight:800; color:var(--text-main); font-size:0.82rem; }
    .temp-card-phone a { color:var(--accent-wechat); text-decoration:none; font-weight:700; font-size:0.78rem; }
    .temp-card-info { color:var(--text-soft); font-size:0.7rem; display:flex; flex-wrap:wrap; gap:4px 12px; }
    .temp-card-note { color:var(--text-main); font-size:0.72rem; line-height:1.4; }
    .temp-card-actions { display:flex; gap:6px; margin-left:auto; flex-shrink:0; align-items:center; }
    .temp-card-actions button { width:32px; height:32px; background:none; border:0.5px solid var(--card-border); cursor:pointer; font-size:0; padding:0; border-radius:var(--radius-sm); display:inline-flex; align-items:center; justify-content:center; color:var(--text-soft); transition:all 0.15s; }
    .temp-card-actions button:hover { background:var(--btn-hover); transform:translateY(-1px); }
    .temp-card-actions button:active { transform:translateY(0); }
    .temp-card-actions .temp-tbl-export { color:var(--accent-wechat); }
    .temp-card-actions .temp-tbl-edit { color:var(--text-soft); }
    .temp-card-actions .temp-tbl-convert { color:var(--accent-intent); }
    .temp-card-actions .temp-tbl-del { color:#ff3b30; }
    .temp-full-table { display:none; }
    .temp-card-list { display:flex; }
    @media (min-width:761px) {
      .temp-card-list { display:grid; grid-template-columns:repeat(2,1fr); }
    }

    /* ===== 全量客户卡片布局 ===== */
    .all-client-card {
      margin-bottom: 10px;
      padding-right: 60px;
    }
    .all-client-card-editing {
      border-color: var(--accent-wechat) !important;
      box-shadow: 0 0 0 1px rgba(90,106,126,0.2) !important;
    }
    .card-action-btn {
      background: none;
      border: 0.5px solid var(--card-border);
      color: var(--text-soft);
      cursor: pointer;
      font-size: 0.72rem;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: var(--radius-sm);
      transition: all 0.15s;
    }
    .card-action-btn:hover {
      background: var(--btn-hover);
      border-color: var(--accent-wechat);
      color: var(--accent-wechat);
    }
    /* ==================== Android 专属适配 ==================== */
    body.android { font-family: Inter, Roboto, "Noto Sans CJK SC", "Noto Sans SC", sans-serif; }
    /* Android 使用 static vh 避免 toolbar 收展导致 dvh 布局抖动 */
    body.android .app-shell { height: 100vh; height: -webkit-fill-available; padding-top: 39px; }
    /* Android backdrop-filter 性能差，降低或关闭 */
    body.android .card { backdrop-filter: none; -webkit-backdrop-filter: none; }
    body.android .menu-dropdown { backdrop-filter: none; -webkit-backdrop-filter: none; }
    body.android .pin-box { backdrop-filter: none; -webkit-backdrop-filter: none; background: rgba(255,255,255,0.85); }
    body.android .privacy-mask { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
    body.android .modal-overlay { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
    body.android .circle-btn { backdrop-filter: none; }
    body.android .reset-mini { backdrop-filter: none; }
    /* Android 锁屏 PIN 框 — 同桌面居中 */

    /* Whitelist management modal */
    .whitelist-textarea {
      width: 100%;
      height: 100px;
      background: var(--btn-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-xs);
      padding: 8px 10px;
      font-size: 0.72rem;
      color: var(--text-main);
      outline: none;
      font-weight: 600;
      resize: none;
      line-height: 1.5;
    }
    .whitelist-textarea:focus {
      border-color: var(--accent-wechat);
    }
    .whitelist-company-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 10px;
      background: var(--btn-bg);
      border-radius: var(--radius-xs);
      border: 1px solid var(--card-border);
      margin-bottom: 6px;
    }
    .whitelist-company-item:last-child {
      margin-bottom: 0;
    }

    /* ==================== 贷款利息计算器 ==================== */
    #loanModal .modal-card { overflow-y: auto; background: rgba(255,255,255,0.94); backdrop-filter: none; -webkit-backdrop-filter: none; border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 8px 40px rgba(0,0,0,0.12); max-width: 680px; width: 95%; gap: 20px; padding: 28px 32px; }
    body.dark-mode #loanModal .modal-card { background: rgba(30,30,30,0.96); border-color: rgba(255,255,255,0.06); }
    /* Tabs */
    .loan-tabs { display: flex; gap: 0; border-bottom: 2px solid rgba(0,0,0,0.1); margin-bottom: 4px; }
    body.dark-mode .loan-tabs { border-bottom-color: rgba(255,255,255,0.12); }
    .loan-tab { padding: 10px 22px; font-size: 0.9rem; font-weight: 700; cursor: pointer; border: none; background: transparent; color: #555; border-bottom: 2px solid transparent; margin-bottom: -2px; transition: 0.15s; }
    body.dark-mode .loan-tab { color: #999; }
    .loan-tab:hover { color: #111; }
    body.dark-mode .loan-tab:hover { color: #ddd; }
    .loan-tab.active { color: #0d9488; border-bottom-color: #0d9488; }
    body.dark-mode .loan-tab.active { color: #2dd4bf; border-bottom-color: #2dd4bf; }
    /* Input area */
    .loan-grid { display: flex; flex-direction: column; gap: 12px; background: rgba(0,0,0,0.025); border-radius: 10px; padding: 18px; }
    body.dark-mode .loan-grid { background: rgba(255,255,255,0.025); }
    .loan-input-row { display: flex; gap: 12px; align-items: center; }
    .loan-input-row label { font-size: 0.9rem; font-weight: 700; color: #111; white-space: nowrap; min-width: 75px; }
    body.dark-mode .loan-input-row label { color: #ddd; }
    .loan-input-row .input-simple { flex: 1; min-width: 0; width: auto; background: #fff; border: 1.5px solid #d0d0d0; border-radius: 8px; padding: 10px 14px; font-size: 1rem; height: 44px; color: #111; font-weight: 700; }
    body.dark-mode .loan-input-row .input-simple { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2); color: #ddd; }
    .loan-input-row .input-simple:focus { border-color: #0d9488; box-shadow: 0 0 0 3px rgba(13,148,136,0.15); outline: none; }
    .loan-unit { font-size: 0.85rem; color: #555; font-weight: 600; white-space: nowrap; }
    body.dark-mode .loan-unit { color: #aaa; }
    .loan-copy-btn { min-height: 32px; padding: 0 12px; border-radius: 10px; border: 0.5px solid var(--card-border); background: var(--btn-bg); color: var(--text-main); font-size: 0.78rem; font-weight: 600; cursor: pointer; white-space: nowrap; }
    body.dark-mode .loan-copy-btn { color: #eee; }
    .loan-input-desc { font-size: 0.72rem; color: #777; margin-left: 4px; }
    body.dark-mode .loan-input-desc { color: #999; }
    /* 计息天数 */
    .loan-method-field { display: none; margin-top: 4px; }
    .loan-method-field.visible { display: block; }
    /* Result cards */
    .loan-results { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .loan-result-card { background: #fff; border-radius: 10px; padding: 16px 10px; text-align: center; border: 1px solid #d8d8d8; }
    body.dark-mode .loan-result-card { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.1); }
    .loan-result-card .label { font-size: 0.78rem; color: #555; font-weight: 700; margin-bottom: 8px; letter-spacing: 0.3px; }
    body.dark-mode .loan-result-card .label { color: #aaa; }
    .loan-result-card .value { font-size: 1.3rem; font-weight: 900; color: #111; }
    body.dark-mode .loan-result-card .value { color: #eee; }
    .loan-result-card .value.positive { color: #0d9488; }
    .loan-result-card .value.warning { color: #d97706; }
    /* Section titles */
    #loanModal .modal-section-title { font-size: 0.88rem; font-weight: 800; color: #333; margin-top: 4px; }
    body.dark-mode #loanModal .modal-section-title { color: #ccc; }
    /* Comparison table */
    .loan-compare-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    .loan-compare-table th { background: rgba(0,0,0,0.05); padding: 10px 12px; font-weight: 800; color: #333; border-bottom: 2px solid #c0c0c0; text-align: center; font-size: 0.8rem; }
    body.dark-mode .loan-compare-table th { background: rgba(255,255,255,0.05); color: #ccc; border-bottom-color: rgba(255,255,255,0.15); }
    .loan-compare-table td { padding: 9px 12px; border-bottom: 1px solid #d8d8d8; text-align: center; font-weight: 600; background: #fff; color: #111; }
    body.dark-mode .loan-compare-table td { background: transparent; border-bottom-color: rgba(255,255,255,0.08); color: #ddd; }
    .loan-compare-table tr:last-child td { border-bottom: none; }
    /* Schedule table */
    .loan-schedule-wrap { max-height: 320px; overflow-y: auto; border: 1px solid #c0c0c0; border-radius: 8px; }
    body.dark-mode .loan-schedule-wrap { border-color: rgba(255,255,255,0.15); }
    .loan-schedule-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    .loan-schedule-table th { position: sticky; top: 0; background: rgba(0,0,0,0.05); padding: 9px 10px; font-weight: 800; color: #333; border-bottom: 2px solid #c0c0c0; text-align: center; z-index: 1; font-size: 0.78rem; }
    body.dark-mode .loan-schedule-table th { background: rgba(255,255,255,0.05); color: #ccc; border-bottom-color: rgba(255,255,255,0.15); }
    .loan-schedule-table td { padding: 7px 10px; border-bottom: 1px solid #d8d8d8; text-align: center; font-weight: 600; color: #111; }
    body.dark-mode .loan-schedule-table td { border-bottom-color: rgba(255,255,255,0.08); color: #ddd; }
    .loan-schedule-table tr:last-child td { border-bottom: none; }
    .loan-schedule-table tr:nth-child(even) td { background: rgba(0,0,0,0.02); }
    body.dark-mode .loan-schedule-table tr:nth-child(even) td { background: rgba(255,255,255,0.02); }
    @media (max-width: 760px) {
      .loan-results { grid-template-columns: repeat(2, 1fr); }
      .loan-tab { padding: 8px 12px; font-size: 0.82rem; }
      #loanModal .modal-card { padding: 18px 14px; }
      .loan-grid { padding: 14px; }
      .loan-input-row label { font-size: 0.82rem; min-width: 65px; }
      .loan-input-row .input-simple { font-size: 0.9rem; height: 40px; }
    }
    /* PWA 安装引导条 */
    .pwa-install-banner { display: none; position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999; background: rgba(0,0,0,0.92); color: #fff; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); font-size: 0.78rem; font-weight: 600; text-align: center; letter-spacing: 0.3px; backdrop-filter: blur(10px); }
    .pwa-install-banner.show { display: block; animation: slideUp 0.3s ease; }
    .pwa-install-banner .pwa-close { position: absolute; top: 6px; right: 12px; font-size: 1.1rem; cursor: pointer; opacity: 0.5; padding: 4px; }
    @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
  </style>
  <script src="/xlsx.full.min.js"></script>
</head>
<body class="page-hidden" style="visibility:hidden">
<div class="pwa-install-banner" id="pwaInstallBanner">
  点击底部 <b>分享</b> → <b>添加到主屏幕</b>，即可全屏使用
  <span class="pwa-close" onclick="var b=document.getElementById('pwaInstallBanner');b.classList.remove('show');localStorage.setItem('pwa_banner_dismissed','1');">✕</span>
</div>
<script>
(function(){
  var isIOS=/iPhone|iPad|iPod/.test(navigator.userAgent);
  var isStandalone=window.navigator.standalone;
  var dismissed=localStorage.getItem('pwa_banner_dismissed');
  if(isIOS&&!isStandalone&&!dismissed){
    document.getElementById('pwaInstallBanner').classList.add('show');
  }
})();
</script>
<script>
(function(){
  var tk=localStorage.getItem('auth_token');
  if(!tk){document.body.className='page-auth';}
  localStorage.removeItem('unlock_ts');
  document.body.style.visibility='visible';
})();
</script>
<div class="notify-bar" id="notifyBar" onclick="this.classList.remove('show')"><span id="notifyText"></span><span class="notify-close">✕</span></div>
<div class="wallpaper-fallback"></div>
<div class="wallpaper-background" id="wallpaperBackground"></div>
<div class="privacy-wallpaper" id="privacyWallpaper"></div>
<div class="timer-container" id="timerContainer">
  <div class="timer-box" id="timerBox">
    <div class="timer-display" id="timerDisplay">00:00:00</div>
    <div class="timer-inputs">
      <div class="timer-input-group">
        <input type="number" class="timer-input" id="timerHours" min="0" max="23" value="0" placeholder="0" autocomplete="off">
        <span class="timer-label">时</span>
      </div>
      <span class="timer-separator">:</span>
      <div class="timer-input-group">
        <input type="number" class="timer-input" id="timerMinutes" min="0" max="59" value="1" placeholder="0" autocomplete="off">
        <span class="timer-label">分</span>
      </div>
      <span class="timer-separator">:</span>
      <div class="timer-input-group">
        <input type="number" class="timer-input" id="timerSeconds" min="0" max="59" value="0" placeholder="0" autocomplete="off">
        <span class="timer-label">秒</span>
      </div>
    </div>
    <div class="timer-buttons">
      <button class="timer-btn timer-btn-start" id="timerStartBtn">启动</button>
      <button class="timer-btn timer-btn-reset" id="timerResetBtn">重置</button>
    </div>
  </div>
</div>
<div class="auth-gate" id="authGate">
  <div class="auth-box">
    <h3 class="auth-title">生活记事录</h3>
    <div class="auth-form" id="authFormLogin">
      <input type="text" class="auth-input" id="authUsername" placeholder="账号" autocomplete="username">
      <input type="password" class="auth-input" id="authPassword" placeholder="密码" autocomplete="current-password">
      <button class="auth-btn" id="authLoginBtn">登录</button>
      <div class="auth-switch">没有账号？<a id="authSwitchRegister">创建账号</a></div>
    </div>
    <div class="auth-form" id="authFormRegister" style="display:none">
      <input type="text" class="auth-input" id="authRegUsername" placeholder="设置账号" autocomplete="username">
      <input type="password" class="auth-input" id="authRegPassword" placeholder="设置密码（至少4位）" autocomplete="new-password">
      <input type="password" class="auth-input" id="authRegPassword2" placeholder="确认密码" autocomplete="new-password">
      <button class="auth-btn" id="authRegisterBtn">创建账号</button>
      <div class="auth-switch">已有账号？<a id="authSwitchLogin">登录</a></div>
    </div>
    <div class="auth-error" id="authError"></div>
  </div>
</div>
<div class="privacy-mask" id="privacyMask">
  <div class="script-container" id="scriptContainer"></div>
  <div class="learn-container" id="learnContainer"></div>
  <div class="pin-box">
    <div id="turnstileWidget" style="min-height:65px;display:flex;align-items:center;justify-content:center;"></div>
    <input type="text" class="pin-input pin-mask" id="pinInput" placeholder="" maxlength="6" inputmode="numeric" autocomplete="off" spellcheck="false" data-lpignore="true" readonly onfocus="this.removeAttribute('readonly');" autofocus disabled>
    <button class="pin-btn" id="pinUnlockBtn" disabled>验证中...</button>
    <div class="pin-error" id="pinError"></div>
    <input type="file" id="restoreFileInput" accept=".json" style="display:none;">
    <button class="pin-btn" id="restoreBtn" style="display:none;background:rgba(52,211,153,0.15);color:#059669;border:1px solid rgba(52,211,153,0.3);margin-top:4px;">恢复数据</button>
  </div>
</div>
<div class="journal-shell" id="journalShell">
  <div class="topbar">
    <span class="topbar-logo">生活记事录</span>
    <input class="topbar-search" id="journalSearch" placeholder="搜索记录...">
    <button class="topbar-btn" id="journalNewBtn">新建记录</button>
    <button class="topbar-btn" id="journalLockBtn" style="background:rgba(0,0,0,0.06);color:var(--text-main)">锁屏</button>
  </div>
  <div class="journal-body">
    <nav class="sidebar">
      <a class="sidebar-item active" data-page="home">首页</a>
      <a class="sidebar-item" data-page="calendar">日历</a>
      <a class="sidebar-item" data-page="mood">心情统计</a>
      <a class="sidebar-item" data-page="tags">标签</a>
      <a class="sidebar-item" data-page="settings">设置</a>
    </nav>
    <main class="journal-main" id="journalMain">
      <div class="journal-empty">还没有今天的记录<br>点击「新建记录」开始写日记吧</div>
    </main>
  </div>
</div>
<div class="app-shell">
  <div class="container">
    <div class="header-bar">
      <h3>生活记事录</h3><div class="date-chip" id="liveDate"></div><button class="goal-eye eye-off" id="goalEyeBtn" title="显示目标数字">👁</button><div class="goal-chips" id="goalChips"></div><button class="icon-simple" id="loanCalcBtn" title="贷款利息计算器" style="margin-left:auto">计算器</button><button class="icon-simple" id="hideBtn" title="一键隐藏 (Ctrl+Z)">锁屏</button><button class="icon-simple" id="menuToggleBtn" title="菜单">≡</button><div class="menu-dropdown" id="menuDropdown"><button class="menu-item" id="logBtn">同步日志</button><button class="menu-item" id="scriptBtn">话术管理</button><button class="menu-item" id="learnBtn">学习管理</button><button class="menu-item" id="exportBtn">导出数据</button><button class="menu-item" id="goalBtn">目标设定</button><button class="menu-item" id="whitelistMenuBtn">白名单管理</button><button class="menu-item" id="darkToggleBtn">深色模式</button><button class="menu-item" id="logoutMenuBtn" style="color:#e74c3c">退出登录</button></div>
    </div>
    <div class="two-columns">
      <div class="left-area">
        <div class="card" style="position: relative; z-index: 10; overflow: visible;">
          <div class="card-title" style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:0.72rem;">白名单快捷查询</span>
            <span style="font-size:0.55rem; color:var(--text-soft); font-weight:normal;" id="mainWlStatus">建行建易贷</span>
          </div>
          <div class="register-block" style="position: relative;">
            <input type="text" class="input-simple" id="mainWlSearchInput" placeholder="输入企业名称进行模糊搜索..." autocomplete="off" style="width:100%; box-sizing:border-box; padding:10px 12px; height:38px; font-size:0.72rem;">
            <div id="mainWlSearchResults" style="display:none; position:absolute; top:calc(100% + 4px); left:0; right:0; background:var(--card-bg); border:1px solid var(--card-border); border-radius:var(--radius-xs); box-shadow:var(--shadow-md); z-index:100; max-height:180px; overflow-y:auto; padding:4px; flex-direction:column; gap:4px; text-align:left; box-sizing:border-box;"></div>
          </div>
        </div>
        <div class="counter-row">
          <div class="counter-card wechat-fill">
            <div class="counter-header"><span class="counter-label">微信</span><div class="button-group"><button class="circle-btn" id="wechatMinus">−</button><button class="circle-btn btn-special" id="wechatPlus">+</button></div></div>
            <div class="counter-value" id="wechatNum">0</div>
            <div class="counter-stats"><span>本周 <b id="weekWechat">0</b></span><span>本月 <b id="monthWechat">0</b></span></div>
          </div>
          <div class="counter-card intent-fill">
            <div class="counter-header"><span class="counter-label">意向</span></div>
            <div class="counter-value" id="intentNum">0</div>
            <div class="counter-stats"><span>本周 <b id="weekIntent">0</b></span><span>本月 <b id="monthIntent">0</b></span></div>
          </div>
          <div class="counter-card revisit-fill">
            <div class="counter-header"><span class="counter-label">回访</span><div class="button-group"><button class="circle-btn" id="revisitMinus">−</button><button class="circle-btn btn-special" id="revisitPlus">+</button></div></div>
            <div class="counter-value" id="revisitNum">0</div>
            <div class="counter-stats"><span>本周 <b id="weekRevisit">0</b></span><span>本月 <b id="monthRevisit">0</b></span></div>
          </div>
        </div>
        <div class="card calendar-compact">
          <div class="cal-head"><button class="cal-nav-btn" id="calPrevBtn" title="上个月">◀</button><span id="calMonthTitle"></span><button class="cal-nav-btn" id="calNextBtn" title="下个月">▶</button></div>
          <div class="cal-grid" id="calGrid"></div>
          <div style="font-size:0.55rem;text-align:center;margin-top:6px;color:var(--text-light);font-weight:600;">点击日期查看意向客户</div>
        </div>
      </div>
      <div class="right-area">
        <div class="card">
          <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;">意向登记 <button id="allClientsBtn" title="意向客户全量表" style="font-size:0.65rem;padding:3px 10px;border-radius:var(--radius-xs);border:none;background:var(--accent-btn);color:#fff;font-weight:700;cursor:pointer;">全量</button></div>
          <div class="register-block">
            <div class="form-line"><input type="text" class="input-simple" id="custName" placeholder="姓名" autocomplete="off"><input type="text" class="input-simple" id="custPhone" placeholder="电话" autocomplete="off"></div>
            <div class="form-line"><input type="text" class="input-simple" id="custCompany" placeholder="单位" autocomplete="off"><input type="text" class="input-simple" id="custFund" placeholder="公积金基数" autocomplete="off"></div>
            <div class="form-line"><select class="input-simple input-select" id="custLabel" required style="font-weight:700;font-size:0.85rem;color:var(--text-main);padding:8px 10px;border-radius:var(--radius-xs);width:100%;cursor:pointer;"><option value="">客户等级 *</option><option value="A">A 类 — 重点跟进</option><option value="B">B 类 — 常规跟进</option><option value="C">C 类 — 低优先级</option></select></div>
            <!-- Collapsible detail panel toggle -->
            <div class="detail-toggle-wrap">
              <button type="button" class="detail-toggle-btn" id="detailToggleBtn">
                <span class="detail-toggle-icon">▶</span> 详细资料
              </button>
            </div>
            <div class="detail-panel" id="detailPanel" style="display:none;">
              <div class="form-line"><input type="text" class="input-simple" id="custAge" placeholder="客户年龄" autocomplete="off" inputmode="numeric"><select class="input-simple input-select" id="custMaritalStatus"><option value="">婚姻状况</option><option value="未婚">未婚</option><option value="已婚">已婚</option><option value="离异">离异</option><option value="丧偶">丧偶</option></select></div>
              <div class="form-line"><select class="input-simple input-select" id="custIsShenzhenHukou"><option value="">是否深户</option><option value="是">是</option><option value="否">否</option></select><select class="input-simple input-select" id="custEducation"><option value="">学历</option><option value="初中及以下">初中及以下</option><option value="高中">高中</option><option value="大专">大专</option><option value="本科">本科</option><option value="硕士">硕士</option><option value="博士">博士</option></select></div>
              <div class="form-line"><input type="text" class="input-simple" id="custSocialSecurity" placeholder="社保养老基数" autocomplete="off" inputmode="numeric"><input type="text" class="input-simple" id="custAvgSalary" placeholder="月均工资" autocomplete="off" inputmode="numeric"></div>
              <div class="form-line"><input type="text" class="input-simple" id="custTax2yr" placeholder="近2年个税" autocomplete="off" inputmode="numeric"><input type="text" class="input-simple" id="custSalaryBank" placeholder="代发工资银行" autocomplete="off"></div>
              <div class="form-line"><select class="input-simple input-select" id="custProperty"><option value="">房产</option><option value="无房">无房</option><option value="有一套">有一套</option><option value="有多套">有多套</option></select><select class="input-simple input-select" id="custPropertyType"><option value="">深房/外地房</option><option value="深房">深房</option><option value="外地房">外地房</option></select></div>
              <div class="form-line"><input type="text" class="input-simple" id="custPropertyAddress" placeholder="房产地址" autocomplete="off"><input type="text" class="input-simple" id="custPropertyArea" placeholder="面积" autocomplete="off"></div>
              <div class="form-line"><input type="text" class="input-simple" id="custPropertyMortgageBank" placeholder="抵押银行" autocomplete="off"><input type="text" class="input-simple" id="custPropertyMortgageAmount" placeholder="还欠多少" autocomplete="off" inputmode="numeric"></div>
              <div class="form-line"><input type="text" class="input-simple" id="custBankDebt" placeholder="银行信贷负债" autocomplete="off" inputmode="numeric"><input type="text" class="input-simple" id="custCreditCardDebt" placeholder="信用卡负债" autocomplete="off" inputmode="numeric"></div>
              <div class="form-line"><input type="text" class="input-simple" id="custQuery3m" placeholder="近3个月查询次数" autocomplete="off" inputmode="numeric"><input type="text" class="input-simple" id="custOnlineLoanCount" placeholder="小额网贷笔数" autocomplete="off" inputmode="numeric"></div>
              <div class="form-line"><textarea class="input-simple note-textarea" id="custPropertyOther" placeholder="房产其他情况" rows="2" style="width:100%;"></textarea></div>
              <div class="form-line"><input type="text" class="input-simple" id="custVisitTime" placeholder="上门办理时间" autocomplete="off"><select class="input-simple input-select" id="custStatus"><option value="">状态（未标记）</option><option value="success">已办理成功</option><option value="failed">未办理成功</option></select></div>
              <div class="status-conditional-area" id="successStatusFields"><div class="status-field-separator">办理成功信息</div><div class="form-line"><input type="text" class="input-simple" id="custApprovedBank" placeholder="批款银行" autocomplete="off"><input type="text" class="input-simple" id="custApprovedAmount" placeholder="批款金额" autocomplete="off"></div><div class="form-line"><input type="text" class="input-simple" id="custRateTerm" placeholder="利率年限" autocomplete="off"><span style="flex:1;"></span></div></div>
              <div class="status-conditional-area" id="failedStatusFields"><div class="status-field-separator">办理未成功信息</div><div class="form-line"><input type="text" class="input-simple" id="custRejectedBank" placeholder="拒绝银行" autocomplete="off"><input type="text" class="input-simple" id="custRejectReason" placeholder="拒绝原因" autocomplete="off"></div></div>
              <textarea class="input-simple note-textarea" id="custDemand" placeholder="客户大致需求" rows="2"></textarea>
              <textarea class="input-simple note-textarea" id="custFundUsage" placeholder="资金用途和时间" rows="2"></textarea>
              <textarea class="input-simple note-textarea" id="custNote" placeholder="沟通记录 (必填)" rows="3"></textarea>
              <textarea class="input-simple note-textarea" id="custFollowUp" placeholder="跟进情况" rows="2"></textarea>
              <div id="keyQuestionsIntent"></div>
            </div>
            <button type="button" class="btn-add" id="addClientBtn">+ 添加</button>
                        <div class="client-scroll" id="clientList"></div>
          </div>
        </div>
        <div class="card paste-card empty">
          <div class="paste-view" id="pasteView">
            <div class="paste-empty-state">
              <span class="paste-empty-label">暂无内容</span>
              <span class="paste-empty-hint">添加内容：右上角菜单 → 学习管理</span>
            </div>
          </div>
          <button type="button" class="paste-arrow paste-arrow-left" id="pasteArrowPrev" title="上一段" aria-label="上一段"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
          <button type="button" class="paste-arrow paste-arrow-right" id="pasteArrowNext" title="下一段" aria-label="下一段"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
        </div>
        <div class="card">
          <div class="card-title" style="display:flex;align-items:center;">临时登记 (待晚回访) <button class="btn-add" id="allTempTableBtn" style="font-size:0.65rem;padding:2px 8px;margin-left:auto;">临时表</button></div>
          <div class="register-block">
            <div class="form-line"><input type="text" class="input-simple" id="tempCustName" placeholder="姓名" autocomplete="off" readonly onfocus="this.removeAttribute('readonly');"><input type="text" class="input-simple" id="tempCustPhone" placeholder="电话/联系方式" autocomplete="off" readonly onfocus="this.removeAttribute('readonly');"></div>
            <div class="form-line"><input type="text" class="input-simple" id="tempCustCompany" placeholder="单位" autocomplete="off" readonly onfocus="this.removeAttribute('readonly');"><input type="text" class="input-simple" id="tempCustFund" placeholder="公积金基数" autocomplete="off" readonly onfocus="this.removeAttribute('readonly');"></div>
            <div style="display:flex;gap:4px;align-items:center;">
              <textarea class="input-simple note-textarea" id="tempCustNote" placeholder="回访备注/待聊内容" rows="2" style="flex:1;"></textarea>
              <button type="button" id="boldBtn" title="加粗 (Alt+B)" style="height:28px;width:28px;font-weight:900;font-size:0.7rem;border:1px solid var(--card-border);background:var(--btn-bg);color:var(--text-main);cursor:pointer;border-radius:3px;padding:0;line-height:1;">B</button>
              <button type="button" id="delBtn" title="删除线 (Alt+D)" style="height:28px;width:28px;font-weight:700;font-size:0.6rem;border:1px solid var(--card-border);background:var(--btn-bg);color:var(--text-main);cursor:pointer;border-radius:3px;padding:0;line-height:1;text-decoration:line-through;">D</button>
            </div>
            <div class="detail-toggle-wrap"><button type="button" class="detail-toggle-btn" id="tkqToggleBtn"><span class="detail-toggle-icon">▶</span> 关键问题勾选</button></div>
            <div class="detail-panel" id="tkqPanel" style="display:none;"><div id="keyQuestionsTemp"></div></div>
            <div style="display:flex;gap:4px;">
              <button class="btn-add" id="addTempCustBtn" style="background:var(--accent-btn);flex:1;">+ 登记</button>
              <button class="btn-add" id="cancelTempEditBtn" style="background:var(--btn-bg);color:var(--text-soft);display:none;padding:0 12px;font-size:0.72rem;">取消</button>
            </div>
            <div class="client-scroll" id="tempClientList"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title" style="display:flex;align-items:center;gap:10px;">
            <span>待办</span>
            <div class="todo-tab-switch" id="todoTabSwitch">
              <button class="todo-tab-btn active" data-tab="today">今日</button>
              <button class="todo-tab-btn" data-tab="tomorrow">明日</button>
            </div>
          </div>
          <div class="register-block">
            <div class="todo-input-row"><input type="text" class="todo-input" id="todoInput" placeholder="添加待办..." autocomplete="off"><input type="time" class="todo-input time-input-compact" id="todoRemindTime" autocomplete="off"><button class="todo-add-btn" id="addTodoBtn">+ 添加</button></div>
            <div class="todo-list" id="todoList"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<div id="globalTooltip" class="tooltip-simple"></div>
<div id="pasteModal" class="modal-overlay">
  <div class="modal-card" style="width:94%;max-width:560px;">
    <div class="modal-header"><span>添加内容</span><button id="closePasteModalBtn" type="button">×</button></div>
    <div class="paste-editor" id="pasteEditor" contenteditable="true" data-placeholder="从 Word / 微信 / 网页复制文字后，长按或 Ctrl+V 粘贴到这里（字体、字号、字间距、行距、缩进都会保留）"></div>
    <div class="paste-btn-row" style="margin-top:10px;">
      <button type="button" class="paste-cancel-btn" id="pasteCancelBtn">取消</button>
      <button type="button" class="paste-save-btn" id="pasteSaveBtn">保存</button>
    </div>
  </div>
</div>
<div id="scriptModal" class="modal-overlay">
  <div class="modal-card script-input-modal">
    <div class="modal-header"><span>话术管理</span><button id="closeScriptModalBtn">×</button></div>
    <textarea id="newScriptInput" placeholder="输入话术内容..."></textarea>
    <button class="btn-add" id="addScriptBtn" style="width:100%;">+ 添加话术</button>
    <div class="script-list" id="scriptList"></div>
  </div>
</div>
<div id="learnModal" class="modal-overlay">
  <div class="modal-card script-input-modal" style="max-width: 500px; width: 90%;">
    <div class="modal-header">
      <span style="font-weight:900;">AI学习管理</span>
      <button id="closeLearnModalBtn">×</button>
    </div>
    
    <div style="display:flex; gap:6px; margin-bottom:10px;">
      <span style="font-size:0.75rem; color:var(--text-soft); align-self:center; font-weight:700;">来源类型:</span>
      <select id="learnSourceSelect" class="input-simple" style="flex:1; font-size:0.75rem; height:32px; padding:0 8px; border-radius:var(--radius-xs); font-weight:700;">
        <option value="微信聊天" selected>微信聊天 (WeChat Chat)</option>
        <option value="电话录音">电话录音 (Phone Recording)</option>
        <option value="客户案例">客户案例 (Client Case)</option>
        <option value="企业资料">企业资料 (Company Info)</option>
      </select>
    </div>

    <textarea id="newLearnInput" placeholder="在此输入或粘贴原始材料（如：微信聊天记录、录音文字转写、批贷案例描述、白名单政策等）..." style="min-height: 120px; font-size: 0.75rem; line-height: 1.5; margin-bottom: 10px;"></textarea>


    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px;">
      <label class="learn-check-row" style="margin-bottom:0; font-weight:700; cursor:pointer;">
        <input type="checkbox" id="learnShowCheck" checked style="margin-right:4px;">锁屏显示
      </label>
      <div style="display:flex; gap:8px; flex:1; justify-content:flex-end;">
        <button class="btn-add" id="aiLearnBtn" style="background: linear-gradient(135deg, #34D399 0%, #12A874 100%); color:white; border:none; padding:8px 16px; font-size:0.75rem; border-radius:var(--radius-xs); cursor:pointer; font-weight:800; display:flex; align-items:center; gap:4px; box-shadow: 0 2px 6px rgba(52,211,153,0.35);">
          AI 智能总结
        </button>
        <button class="btn-add" id="addLearnBtn" style="background: var(--btn-bg); color:var(--text-main); border:1px solid var(--card-border); padding:8px 16px; font-size:0.75rem; border-radius:var(--radius-xs); cursor:pointer; font-weight:800;">
          手动保存
        </button>
      </div>
    </div>

    <details id="aiConfigDetails" style="margin-bottom:12px; border:1px dashed var(--card-border); border-radius:var(--radius-xs); padding:6px 10px; background:rgba(120,120,120,0.02);">
      <summary style="font-size:0.7rem; color:var(--text-soft); cursor:pointer; font-weight:700; outline:none; user-select:none;">AI 大模型配置 (选填)</summary>
      <div style="display:flex; flex-direction:column; gap:6px; margin-top:6px;">
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:0.65rem; color:var(--text-soft); width:50px; font-weight:700;">服务商:</span>
          <select id="aiProviderSelect" class="input-simple" style="flex:1; font-size:0.7rem; height:28px; padding:0 4px; font-weight:700; background:var(--btn-bg); border-color:var(--card-border); color:var(--text-main);">
            <option value="gemini">Google Gemini</option>
            <option value="deepseek">DeepSeek V4 Pro</option>
            <option value="custom">OpenAI / 其它兼容接口</option>
          </select>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:0.65rem; color:var(--text-soft); width:50px; font-weight:700;">API Key:</span>
          <input type="password" class="input-simple" id="aiApiKeyInput" placeholder="输入 API Key / 密钥" style="flex:1; font-size:0.7rem; height:28px; padding:0 8px;" autocomplete="off" spellcheck="false" data-lpignore="true">
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:0.65rem; color:var(--text-soft); width:50px; font-weight:700;">接口地址:</span>
          <input type="text" class="input-simple" id="aiApiBaseInput" placeholder="默认地址" style="flex:1; font-size:0.7rem; height:28px; padding:0 8px;" autocomplete="off">
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:0.65rem; color:var(--text-soft); width:50px; font-weight:700;">模型名称:</span>
          <input type="text" class="input-simple" id="aiModelInput" placeholder="默认模型" style="flex:1; font-size:0.7rem; height:28px; padding:0 8px;" autocomplete="off">
        </div>
        <div style="display:flex; justify-content:flex-end; margin-top:2px;">
          <button id="saveAiConfigBtn" class="btn-add" style="padding:0 16px; font-size:0.7rem; height:28px; margin:0; background:var(--accent-btn); color:white; border:none; border-radius:var(--radius-xs); font-weight:700;">保存配置</button>
        </div>
        <div style="font-size:0.6rem; color:var(--text-light); line-height:1.4; border-top:1px dashed var(--card-border); padding-top:4px; margin-top:2px;">
          配置 API Key 后将使用真实 AI 接口进行知识提取与回复（Gemini 使用其 OpenAI 兼容接口，留空使用内置模拟 AI）。
        </div>
      </div>
    </details>

    <div class="script-list" id="learnList" style="max-height: 220px; overflow-y: auto;"></div>

    <div style="border-top:0.5px solid var(--card-border); margin-top:12px; padding-top:10px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <span style="font-size:0.78rem; font-weight:700; color:var(--text-main);">内容展示</span>
        <button type="button" id="pasteManageAddBtn" class="btn-add" style="font-size:0.7rem; padding:6px 14px; min-height:32px; background:var(--accent-btn); color:white; border:none; border-radius:var(--radius-xs); font-weight:700;">添加内容</button>
      </div>
      <div style="font-size:0.65rem; color:var(--text-light); line-height:1.4; margin-bottom:6px;">从 Word / 微信 / 网页复制文字粘贴保存，页面内容展示卡片会原样显示</div>
      <div id="pasteManageList" style="max-height:200px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;"></div>
    </div>
  </div>
</div>
<div id="exportModal" class="modal-overlay">
  <div class="modal-card" style="max-width:420px; width: 90%;">
    <div class="modal-header"><span>数据导出与配置</span><button id="closeExportModalBtn">×</button></div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;gap:8px;"><button class="btn-add" id="exportWeekBtn" style="flex:1;">导出本周</button><button class="btn-add" id="exportMonthBtn" style="flex:1;">导出本月</button><button class="btn-add" id="exportAllClientsBtn" style="flex:1;background:var(--intent-gradient);">导出全量</button></div>
      <div style="display:flex;gap:8px;"><button class="btn-add" id="exportSoloBtn" style="flex:1;background:var(--revisit-gradient);">逐条导出全量</button></div>
      
      <div style="border-top: 1px solid var(--card-border); padding-top: 10px; margin-top: 5px;">
        <input type="text" class="input-simple" id="webhookUrlInput" placeholder="企业微信群 Webhook URL" style="margin-bottom: 4px;" autocomplete="off">
        <div style="font-size:0.65rem;color:var(--text-light);">用于数据主动导出推送的群机器人 Webhook 地址</div>
      </div>

      <div style="border-top:1px solid var(--card-border);padding-top:10px;margin-top:5px;">
        <div style="font-size:0.75rem;font-weight:700;color:var(--text-main);margin-bottom:6px;">修改解锁密码</div>
        <div style="display:flex;gap:8px;">
          <input type="text" class="input-simple" id="newPinInput" placeholder="新密码 (4-6位数字)" maxlength="6" inputmode="numeric" pattern="[0-9]*" autocomplete="off" style="flex:2;font-size:0.7rem;height:28px;padding:0 8px;">
          <button id="savePinBtn" class="btn-add" style="flex:1;font-size:0.7rem;height:28px;margin:0;background:var(--accent-btn);color:white;border:none;">保存</button>
        </div>
        <div id="pinStatus" style="font-size:0.62rem;padding:4px 0;min-height:18px;"></div>
        <div style="font-size:0.6rem;color:var(--text-light);">默认密码 8520，修改后立即生效，用于解锁页面和删除客户验证</div>
      </div>


      <details style="margin-top:10px; border:1px dashed var(--card-border); border-radius:var(--radius-xs); padding:8px; background:rgba(120,120,120,0.02);">
        <summary style="font-size:0.75rem; color:var(--text-soft); cursor:pointer; font-weight:700; outline:none; user-select:none;">Google Gemini AI 配置</summary>
        <div style="display:flex; flex-direction:column; gap:6px; margin-top:8px;">
          <div style="font-size:0.7rem; color:var(--text-soft); line-height:1.4;">
            配置 Gemini API Key 后，本地 Tesseract OCR 提取的联系人数据将自动通过 Gemini 整理分类（智能排齐姓名、公司、备注等）并修正识别错别字。<br>免费获取 Key: <a href="https://aistudio.google.com/apikey" target="_blank" style="color:#4285f4;font-weight:700;">aistudio.google.com/apikey</a>
          </div>
          <input type="password" class="input-simple" id="visionApiKeyInput" placeholder="Gemini API Key (支持逗号分隔多个key)" style="font-size:0.7rem; height:28px; padding:0 8px;" autocomplete="off" spellcheck="false" data-lpignore="true">
          <input type="text" class="input-simple" id="visionApiBaseInput" placeholder="API Base (可选，默认 Gemini 官方)" style="font-size:0.7rem; height:28px; padding:0 8px;" autocomplete="off">
          <div style="display:flex; gap:6px;">
            <button id="saveVisionConfigBtn" class="btn-add" style="font-size:0.7rem; height:28px; flex:1; margin:0; background:linear-gradient(135deg,#4285f4,#0d47a1); color:white; border:none; font-weight:700;">保存</button>
            <button id="testVisionBtn" class="btn-add" style="font-size:0.7rem; height:28px; flex:1; margin:0; background:linear-gradient(135deg,#36d1dc,#5b86e5); color:white; border:none; font-weight:700;">测试连接</button>
          </div>
          <div id="visionConfigStatus" style="font-size:0.62rem; padding:4px 6px; border-radius:4px; background:var(--btn-bg); display:none; line-height:1.5; margin-top:4px;"></div>
        </div>
      </details>

      <details style="margin-top:10px; border:1px dashed var(--card-border); border-radius:var(--radius-xs); padding:8px; background:rgba(120,120,120,0.02);">
        </div>
      </details>


      <div id="exportStatus" style="font-size:0.75rem;text-align:center;min-height:20px;"></div>
    </div>
  </div>
</div>
<!-- Whitelist Management Modal -->
<div id="whitelistModal" class="modal-overlay">
  <div class="modal-card" style="max-width: 440px;">
    <div class="modal-header">
      <span style="font-weight:900;">白名单管理</span>
      <button id="closeWhitelistBtn" style="background:none; border:none; font-size:1.2rem; cursor:pointer; color:var(--text-soft); padding:0;">✕</button>
    </div>
    <div class="whitelist-status" id="whitelistStatus" style="font-size:0.7rem; color:var(--text-soft); font-weight:700;">未加载白名单</div>
    
    <div style="display:flex; flex-direction:column; gap:6px;">
      <div style="display:flex; gap:8px; align-items:center;">
        <label style="font-size:0.65rem; color:var(--text-light); font-weight:800; flex:1;">粘贴公司名称 (每行一家企业)</label>
        <label for="whitelistFileInput" class="btn-secondary" style="padding:4px 8px; font-size:0.65rem; cursor:pointer; display:inline-block; border-radius:var(--radius-xs); border:1px solid var(--card-border); background:var(--btn-bg); font-weight:700; margin-bottom:2px;">导入表格 (Excel/CSV)</label>
        <a id="whitelistTemplateBtn" class="btn-secondary" style="padding:4px 8px; font-size:0.65rem; cursor:pointer; display:inline-block; border-radius:var(--radius-xs); border:1px solid var(--card-border); background:var(--btn-bg); font-weight:700; margin-bottom:2px; text-decoration:none; color:var(--text-main);">下载模板</a>
        <input type="file" id="whitelistFileInput" accept=".xlsx,.xls,.csv" style="display:none;">
      </div>
      <textarea id="whitelistTextarea" class="whitelist-textarea" placeholder="例：&#10;中国石油化工集团公司&#10;国家电网有限公司&#10;中国工商银行股份有限公司"></textarea>
      <div style="display:flex; gap:8px;">
        <button id="whitelistUploadBtn" class="btn-primary" style="flex:1; padding:8px; font-size:0.78rem;">上传白名单</button>
        <button id="whitelistRefreshBtn" class="btn-secondary" style="padding:8px 14px; font-size:0.78rem;">刷新列表</button>
      </div>
    </div>
    
    <!-- Upload Failed Area -->
    <div id="whitelistFailedArea" style="display:none; border:1px solid #e74c3c; background:rgba(231,76,60,0.05); border-radius:var(--radius-xs); padding:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; font-size:0.7rem; font-weight:800; color:#e74c3c;">
        <span>⚠️ 上次上传失败的企业 (<span id="whitelistFailedCount">0</span>)</span>
        <a href="#" id="whitelistFailedClearBtn" style="color:#e74c3c; text-decoration:underline; font-size:0.65rem;">清除</a>
      </div>
      <div id="whitelistFailedList" style="max-height:80px; overflow-y:auto; font-size:0.68rem; color:var(--text-soft); border:1px solid rgba(231,76,60,0.2); border-radius:4px; padding:4px; background:#fff; margin-bottom:8px; text-align:left; white-space:pre-wrap;"></div>
      <button id="whitelistFailedRetryBtn" class="btn-primary" style="background:#e74c3c; border-color:#e74c3c; color:#fff; width:100%; padding:6px; font-size:0.75rem;">尝试重新上传</button>
    </div>

    <!-- Search in Whitelist -->
    <div style="display:flex; flex-direction:column; gap:6px; border-top: 1px dashed var(--border-light); padding-top:12px; margin-top:4px;">
      <label style="font-size:0.65rem; color:var(--text-light); font-weight:800;">搜索白名单列表</label>
      <input type="text" id="whitelistModalSearchInput" class="search-input" placeholder="输入企业名称进行搜索..." autocomplete="off" style="height:28px; font-size:0.72rem; border-radius:var(--radius-xs); padding:0 8px; border:1px solid var(--card-border); background:var(--btn-bg); color:var(--text-main); font-weight:700; width:100%;">
    </div>

    <div class="modal-section-title" style="margin-top:4px;">企业白名单列表</div>
    <div id="whitelistCompanyList" style="font-size:0.7rem; color:var(--text-light); text-align:center;">点击"刷新列表"加载白名单企业</div>
  </div>
</div>

<div id="logModal" class="modal-overlay">
  <div class="modal-card" style="max-width:420px;">
    <div class="modal-header"><span>同步日志</span><button id="closeLogModalBtn">×</button></div>
    <div class="log-list" id="syncLogList"></div>
  </div>
</div>
<div id="allClientsModal" class="modal-overlay">
  <div class="modal-card" style="width:100vw;height:100vh;max-width:100vw;max-height:100vh;margin:0;border-radius:0;border:none;box-sizing:border-box;">
    <div class="modal-header"><div style="display:flex;align-items:center;gap:12px;"><span>意向客户全量登记表</span><button id="allClientsAddBtn" class="btn-add" style="font-size:0.75rem;padding:4px 12px;height:28px;">+ 新增意向</button><input type="text" id="allClientsSearchInput" class="search-input" placeholder="模糊搜索姓名/电话/单位..." autocomplete="off" style="height:28px;font-size:0.72rem;border-radius:var(--radius-xs);padding:0 8px;border:1px solid var(--card-border);background:var(--btn-bg);color:var(--text-main);font-weight:400;width:180px;"><select id="allClientsSortSelect" style="height:28px;font-size:0.72rem;border-radius:var(--radius-xs);padding:0 4px;border:1px solid var(--card-border);background:var(--btn-bg);color:var(--text-main);font-weight:400;cursor:pointer;"><option value="date">登记日期</option><option value="followup">最近回访</option><option value="norevisit">未回访天数</option><option value="label">客户标签</option><option value="name">姓名</option></select><button id="allClientsSortOrderBtn" title="切换排序方向" style="height:28px;width:28px;font-size:0.85rem;font-weight:700;border-radius:var(--radius-xs);border:1px solid var(--card-border);background:var(--btn-bg);color:var(--text-main);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;">↓</button></div><button id="closeAllClientsModalBtn">✕</button></div>
    <div class="all-clients-stats" id="allClientsStatsBar">
      <span class="stats-item stats-total">总计 <strong id="statsTotal">0</strong></span>
      <span class="stats-item stats-unmarked">未标记 <strong id="statsUnmarked">0</strong></span>
      <span class="stats-item stats-success">成功 <strong id="statsSuccess">0</strong></span>
      <span class="stats-item stats-failed">失败 <strong id="statsFailed">0</strong></span>
    </div>
    <div style="overflow-y:auto;flex:1;min-height:0;margin-top:10px;padding:0 4px;overscroll-behavior:contain;" id="allClientsCardList">
      <!-- JS 动态渲染为卡片 -->
    </div>
  </div>
</div>
<div id="dateModal" class="modal-overlay">
  <div class="modal-card">
    <div class="modal-header"><span id="modalDateTitle">时间线</span><button id="closeModalBtn">×</button></div>
    <div id="modalClientList" class="client-modal-list"></div>
  </div>
</div>
<div id="goalModal" class="modal-overlay">
  <div class="modal-card" style="max-width:420px;">
    <div class="modal-header"><span>目标设定</span><button id="closeGoalModalBtn">×</button></div>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="font-size:0.75rem;font-weight:800;color:var(--text-soft);border-bottom:1px solid var(--border-light);padding-bottom:4px;">每周目标</div>
      <div style="display:flex;gap:8px;align-items:center;"><label style="font-size:0.8rem;font-weight:600;min-width:60px;">上门</label><input type="number" class="input-simple" id="goalWeeklyVisit" min="0" placeholder="0" style="flex:1;" autocomplete="off"></div>
      <div style="display:flex;gap:8px;align-items:center;"><label style="font-size:0.8rem;font-weight:600;min-width:60px;">微信</label><input type="number" class="input-simple" id="goalWeeklyWechat" min="0" placeholder="0" style="flex:1;" autocomplete="off"></div>
      <div style="font-size:0.75rem;font-weight:800;color:var(--text-soft);border-bottom:1px solid var(--border-light);padding-bottom:4px;margin-top:4px;">每月目标</div>
      <div style="display:flex;gap:8px;align-items:center;"><label style="font-size:0.8rem;font-weight:600;min-width:60px;">微信</label><input type="number" class="input-simple" id="goalMonthlyWechat" min="0" placeholder="0" style="flex:1;" autocomplete="off"></div>
      <div style="display:flex;gap:8px;align-items:center;"><label style="font-size:0.8rem;font-weight:600;min-width:60px;">上门</label><input type="number" class="input-simple" id="goalMonthlyVisit" min="0" placeholder="0" style="flex:1;" autocomplete="off"></div>
      <div style="display:flex;gap:8px;align-items:center;"><label style="font-size:0.8rem;font-weight:600;min-width:60px;">回款</label><input type="number" class="input-simple" id="goalMonthlyPayment" min="0" placeholder="0" style="flex:1;" autocomplete="off"></div>
      <button class="btn-add" id="saveGoalBtn" style="width:100%;margin-top:4px;">保存目标</button>
      <div id="goalStatus" style="font-size:0.75rem;text-align:center;min-height:20px;color:var(--text-soft);"></div>
    </div>
  </div>
</div>

<!-- 临时表 -->
<div id="tempFullModal" class="modal-overlay">
  <div class="modal-card" id="tempFullModalCard" style="width:100vw;height:100vh;max-width:100vw;max-height:100vh;margin:0;border-radius:0;border:none;box-sizing:border-box;display:flex;flex-direction:column;">
    <div class="modal-header" style="flex-shrink:0;">
      <span>临时表 <span id="tempFullCount" style="font-size:0.7rem;color:var(--accent-wechat);font-weight:800;"></span></span>
      <button id="closeTempFullModalBtn">×</button>
    </div>
    <div style="overflow:auto;flex:1;min-height:0;padding:0 4px;overscroll-behavior:contain;">
      <div class="temp-card-list" id="tempFullCardList"></div>
    </div>
  </div>
</div>

<!-- 贷款利息计算器 -->
<div id="loanModal" class="modal-overlay">
  <div class="modal-card" id="loanModalCard">
    <div class="modal-header">
      <span>贷款利息计算器</span>
      <button type="button" class="loan-copy-btn" id="copyLoanResultBtn">复制结果</button>
      <button id="closeLoanModalBtn">×</button>
    </div>

    <!-- Method Tabs -->
    <div class="loan-tabs">
      <button class="loan-tab active" data-method="debx">等额本息</button>
      <button class="loan-tab" data-method="xxhb">先息后本</button>
      <button class="loan-tab" data-method="sjjh">随借随还</button>
    </div>

    <!-- Input Section -->
    <div class="loan-grid">
      <div class="loan-input-row">
        <label>贷款金额</label>
        <input type="number" class="input-simple" id="loanPrincipal" placeholder="100000" min="0" step="1000" autocomplete="off">
        <span class="loan-unit">元</span>
      </div>

      <div class="loan-input-row">
        <label>月息</label>
        <input type="number" class="input-simple" id="loanMonthlyRate" placeholder="0.35" min="0" step="0.01" autocomplete="off">
        <span class="loan-unit" id="loanMonthlyUnit">% / 月</span>
      </div>

      <div class="loan-input-row">
        <label>年化利率</label>
        <input type="number" class="input-simple" id="loanAnnualRate" placeholder="4.20" min="0" step="0.01" autocomplete="off">
        <span class="loan-unit">% / 年</span>
      </div>

      <div class="loan-input-row">
        <label>贷款期限</label>
        <select class="input-simple input-select" id="loanTerm" style="cursor:pointer;">
          <option value="12">12</option>
          <option value="24">24</option>
          <option value="36">36</option>
          <option value="60">60</option>
          <option value="84">84</option>
        </select>
        <span class="loan-unit">个月</span>
      </div>

      <div class="loan-input-row">
        <label>月息差</label>
        <input type="number" class="input-simple" id="loanRateSpread" placeholder="0.00" min="0" step="0.01" autocomplete="off">
        <span class="loan-unit" id="loanRateSpreadUnit">% / 月</span>
      </div>

      <div class="loan-input-row">
        <label>服务点数</label>
        <input type="number" class="input-simple" id="loanFinanceCost" placeholder="0.00" min="0" step="0.01" autocomplete="off">
        <span class="loan-unit">%</span>
      </div>
    </div>

    <div class="loan-method-field" id="loanDaysField">
      <div class="loan-input-row">
        <label>计息天数</label>
        <input type="number" class="input-simple" id="loanDays" placeholder="30" min="1" max="3650" step="1" autocomplete="off">
        <span class="loan-unit">天</span>
      </div>
    </div>

    <!-- Result Cards -->
    <div class="loan-results" id="loanResults">
      <div class="loan-result-card">
        <div class="label">总利息</div>
        <div class="value positive" id="loanTotalInterest">--</div>
      </div>
      <div class="loan-result-card">
        <div class="label">总还款</div>
        <div class="value" id="loanTotalRepayment">--</div>
      </div>
      <div class="loan-result-card">
        <div class="label" id="loanMonthlyLabel">月供</div>
        <div class="value" id="loanMonthlyPayment">--</div>
      </div>
      <div class="loan-result-card">
        <div class="label">利息占比</div>
        <div class="value warning" id="loanInterestRatio">--</div>
      </div>
    </div>

    <!-- Spread Result Cards (hidden until rateSpread > 0) -->
    <div class="loan-results" id="loanSpreadResults" style="display:none;">
      <div class="loan-result-card">
        <div class="label">分摊成本</div>
        <div class="value" id="loanSpreadMonthly" style="color:#e74c3c;">--</div>
      </div>
      <div class="loan-result-card">
        <div class="label">成本总金额</div>
        <div class="value" id="loanSpreadTotal" style="color:#e74c3c;">--</div>
      </div>
      <div class="loan-result-card">
        <div class="label">成本占比</div>
        <div class="value" id="loanSpreadPct" style="color:#e74c3c;">--</div>
      </div>
    </div>

    <!-- Financing Cost Result Cards (全部成本 = 服务费金额 + 成本总金额) -->
    <div class="loan-results" id="loanFinanceResults" style="display:none;">
      <div class="loan-result-card">
        <div class="label">服务费金额</div>
        <div class="value" id="loanFinanceAmount" style="color:#e74c3c;">--</div>
      </div>
      <div class="loan-result-card">
        <div class="label">成本总金额</div>
        <div class="value" id="loanSpreadExtraAmount" style="color:#e74c3c;">--</div>
      </div>
      <div class="loan-result-card">
        <div class="label">全部成本</div>
        <div class="value" id="loanTotalCost" style="color:#e74c3c;">--</div>
      </div>
      <div class="loan-result-card">
        <div class="label">全部成本占比</div>
        <div class="value" id="loanCostPct" style="color:#d97706;">--</div>
      </div>
      <div class="loan-result-card">
        <div class="label">实际到账</div>
        <div class="value" id="loanNetReceived" style="color:var(--text-main);">--</div>
      </div>
    </div>

    <!-- Comparison Table -->
    <div class="modal-section-title">三种方式对比</div>
    <div id="loanComparisonContainer"></div>

    <!-- Schedule Table -->
    <div class="modal-section-title">还款计划明细</div>
    <div id="loanScheduleContainer"></div>

  </div>
</div>

<script>
(function(){
  const WECHAT_K='wechat_v3', INTENT_K='intent_v3', CLIENTS_K='clients_v3', REVISIT_K='revisit_v1';
  const VISIT_K='visit_v1', PAYMENT_K='payment_v1', GOALS_K='goals_v1';
  const DARK_K='dark_mode', LOCK_K='locked', TODAY_TODO_K='today_todo_v2', TOMORROW_TODO_K='tomorrow_todo_v2';
  const LAST_LOAD_DATE_K='last_load_date_v1', WALLPAPER_K='wp_cache', SCRIPTS_K='scripts_v1', LEARN_K='learn_v1', LOCAL_TS_K='local_ts_v1';
  let _allClientsCache=[];
  let _allClientsSortField='date';
  let _allClientsSortAsc=false;
  function sortAllClients(clients) {
    var field = _allClientsSortField;
    var asc = _allClientsSortAsc;
    var sorted = clients.slice();
    sorted.sort(function(a, b) {
      var va, vb;
      if (field === 'date') {
        va = (a.date || '') + (a.time || '');
        vb = (b.date || '') + (b.time || '');
      } else if (field === 'followup') {
        var aDates = (a.followUps && a.followUps.length) ? a.followUps.map(function(fu){return fu.date;}).filter(Boolean).sort() : [];
        var bDates = (b.followUps && b.followUps.length) ? b.followUps.map(function(fu){return fu.date;}).filter(Boolean).sort() : [];
        va = aDates.length ? aDates[aDates.length - 1] : '0000-00-00';
        vb = bDates.length ? bDates[bDates.length - 1] : '0000-00-00';
      } else if (field === 'norevisit') {
        va = getDaysSinceLastFollowUp(a);
        vb = getDaysSinceLastFollowUp(b);
      } else if (field === 'label') {
        va = (a.label || 'D');
        vb = (b.label || 'D');
      } else if (field === 'name') {
        va = (a.name || '');
        vb = (b.name || '');
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });
    return sorted;
  }
  const TEMP_CLIENTS_K='temp_clients_v1', PIN_HASH_K='pin_hash_v1';
  const DEFAULT_PIN_HASH = hashPinSimple('8520'); // '7c78e7fa'
  function getPinHash() { return localStorage.getItem(PIN_HASH_K) || DEFAULT_PIN_HASH; }
  const TEMP_CLIENTS_MAP_K='temp_clients_map_v1';
  const OP_QUEUE_K='op_queue_v1'; // 操作队列：持久化到 localStorage，页面关闭后下次打开继续补发
  const DEFAULT_PIN='1983';
  const PULL_INTERVAL=15000; // 15秒拉一次，加快跨设备更新
  let syncTimer=null;

  const getTodayStr=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
  const getCurrentMonth=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');};
  const getCurrentTime=()=>{const n=new Date();return String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0')+':'+String(n.getSeconds()).padStart(2,'0');};
  const loadMap=k=>{try{return JSON.parse(localStorage.getItem(k))||{};}catch(e){return{};}};
  const saveMap=(k,o)=>localStorage.setItem(k,JSON.stringify(o));
  const loadTodos=k=>{try{const d=JSON.parse(localStorage.getItem(k))||[];return d.map(t=>typeof t==='string'?{text:t,time:'',date:getTodayStr()}:t);}catch(e){return[];}};
  const saveTodos=(k,a)=>localStorage.setItem(k,JSON.stringify(a));
  const KEY_QUESTIONS=['你们利息多少?','能贷多少额度?','你们费用怎么收?','怎么办理，需要什么资料?','多久能放款呢?','能不能办?能办下来吗?','我的负债比较高了！','查询比较多?','你们是银行吗?还是中介机构的?','需要抵押吗','需要电核吗','线下我都不相信了，根本办不了线下','晚上非工作时间通过微信的','电话中情绪比较低落的','听完贷款说在开会的','听完贷款说让加微信的','加了微信隔几天通过的'];
  function formatKqDisplay(indices){
    if(!indices||!indices.length)return'';
    var parts=[];
    for(var i=0;i<indices.length;i++){
      var idx=indices[i];
      if(idx>=0&&idx<KEY_QUESTIONS.length)parts.push('<span class="kq-tag">'+esc(KEY_QUESTIONS[idx])+'</span>');
    }
    return parts.length>0?'<div class="kq-tags">'+parts.join('')+'</div>':'';
  }
  function renderKeyQuestionsHTML(prefix,selected){
    var h='<div class="kq-title">关键问题勾选</div><div class="kq-grid">';
    for(var i=0;i<KEY_QUESTIONS.length;i++){
      var id=prefix+i; var sel=selected&&selected.indexOf(i)>=0?' checked':'';
      h+='<label class="kq-check"><input type="checkbox" id="'+id+'"'+sel+'> '+(i+1)+'. '+KEY_QUESTIONS[i]+'</label>';
    }
    h+='</div>'; return h;
  }
  function getKeyQuestionsFromForm(prefix){
    var sel=[];
    for(var i=0;i<KEY_QUESTIONS.length;i++){var el=document.getElementById(prefix+i);if(el&&el.checked)sel.push(i);}
    return sel;
  }
  const loadClients=()=>{try{return JSON.parse(localStorage.getItem(CLIENTS_K))||[];}catch(e){return[];}};
  const loadGoals=()=>{try{return JSON.parse(localStorage.getItem(GOALS_K))||{};}catch(e){return{};}};
  const saveGoals=(g)=>localStorage.setItem(GOALS_K,JSON.stringify(g));
  const pushTodoLog=async (todo,ds)=>{syncOp('pushTodoLog',{todo});};
  const esc=s=>String(s).replace(/[&<>]/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;' })[m]||m);
  const maskPhone=p=>{if(!p||p.length<7)return '****';return '****'.repeat(Math.ceil(p.length/4));};
  function getClientDetailTags(c) {
    let html = '';
    if (c.age) html += '<span class="client-card-tag client-card-tag-detail">年龄:' + esc(c.age) + '</span>';
    if (c.maritalStatus) html += '<span class="client-card-tag client-card-tag-detail">' + esc(c.maritalStatus) + '</span>';
    if (c.isShenzhenHukou) html += '<span class="client-card-tag client-card-tag-detail">深户:' + esc(c.isShenzhenHukou) + '</span>';
    if (c.education) html += '<span class="client-card-tag client-card-tag-detail">' + esc(c.education) + '</span>';
    if (c.property) html += '<span class="client-card-tag client-card-tag-detail">' + esc(c.property) + '</span>';
    if (c.propertyType) html += '<span class="client-card-tag client-card-tag-detail">' + esc(c.propertyType) + '</span>';
    if (c.propertyAddress) html += '<span class="client-card-tag client-card-tag-detail">地址:' + esc(c.propertyAddress.length > 10 ? c.propertyAddress.slice(0,10) + '…' : c.propertyAddress) + '</span>';
    if (c.propertyArea) html += '<span class="client-card-tag client-card-tag-detail">面积:' + esc(c.propertyArea) + '</span>';
    if (c.propertyMortgageBank) html += '<span class="client-card-tag client-card-tag-detail">抵押:' + esc(c.propertyMortgageBank) + '</span>';
    if (c.propertyMortgageAmount) html += '<span class="client-card-tag client-card-tag-detail">欠款:' + esc(c.propertyMortgageAmount) + '</span>';
    if (c.propertyOther) html += '<span class="client-card-tag client-card-tag-detail">房产备注:' + esc(c.propertyOther.length > 12 ? c.propertyOther.slice(0,12) + '…' : c.propertyOther) + '</span>';
    if (c.socialSecurity) html += '<span class="client-card-tag client-card-tag-detail">社保:' + esc(c.socialSecurity) + '</span>';
    if (c.avgSalary) html += '<span class="client-card-tag client-card-tag-detail">月均:' + esc(c.avgSalary) + '</span>';
    if (c.tax2yr) html += '<span class="client-card-tag client-card-tag-detail">个税:' + esc(c.tax2yr) + '</span>';
    if (c.salaryBank) html += '<span class="client-card-tag client-card-tag-detail">银行:' + esc(c.salaryBank) + '</span>';
    if (c.bankDebt) html += '<span class="client-card-tag client-card-tag-detail">信贷:' + esc(c.bankDebt) + '</span>';
    if (c.creditCardDebt) html += '<span class="client-card-tag client-card-tag-detail">信用卡:' + esc(c.creditCardDebt) + '</span>';
    if (c.query3m) html += '<span class="client-card-tag client-card-tag-detail">查询:' + esc(c.query3m) + '次</span>';
    if (c.onlineLoanCount) html += '<span class="client-card-tag client-card-tag-detail">网贷:' + esc(c.onlineLoanCount) + '笔</span>';
    if (c.demand) html += '<span class="client-card-tag client-card-tag-detail">需求:' + esc(c.demand.length > 15 ? c.demand.slice(0,15) + '…' : c.demand) + '</span>';
    if (c.fundUsage) html += '<span class="client-card-tag client-card-tag-detail">资金:' + esc(c.fundUsage.length > 15 ? c.fundUsage.slice(0,15) + '…' : c.fundUsage) + '</span>';
    return html;
  }
  // Status helpers
  var SVG_UNMARKED = '<svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="6"/></svg>';
  var SVG_SUCCESS = '<svg width="17" height="17" viewBox="0 0 17 17" fill="none"><circle cx="8.5" cy="8.5" r="7" fill="currentColor"/><path d="M5.5 8.5l2.5 2 4-4.5" stroke="#fff" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var SVG_FAILED = '<svg width="17" height="17" viewBox="0 0 17 17" fill="none"><circle cx="8.5" cy="8.5" r="7" fill="currentColor"/><path d="M6 6l5 5M11 6l-5 5" stroke="#fff" stroke-width="1.25" stroke-linecap="round"/></svg>';
  const STATUS_LABELS = { 'success': SVG_SUCCESS, 'failed': SVG_FAILED };
  const STATUS_CLASSES = { 'success': 'status-success', 'failed': 'status-failed' };
  const STATUS_BADGE_LABELS = { 'success': '已办理成功', 'failed': '未办理成功' };
  const STATUS_BADGE_CLASSES = { 'success': 'status-badge-success', 'failed': 'status-badge-failed' };
  function getStatusBadgeHtml(c) {
    if (!c.status) return '';
    return '<span class="client-card-status-badge ' + STATUS_BADGE_CLASSES[c.status] + '">' + STATUS_BADGE_LABELS[c.status] + '</span>';
  }
  function getStatusToggleHtml(c) {
    var label = c.status ? STATUS_LABELS[c.status] : SVG_UNMARKED;
    var cls = c.status ? 'status-toggle-btn ' + STATUS_CLASSES[c.status] : 'status-toggle-btn';
    return '<button class="' + cls + '" data-status="' + (c.status||'') + '">' + label + '</button>';
  }
  function getFlagDotHtml(c) {
    var dotCls = c.flagged ? 'flag-dot flag-dot-active' : 'flag-dot';
    return '<button class="' + dotCls + '" data-flagged="' + (c.flagged ? '1' : '0') + '" title="' + (c.flagged ? '取消标记' : '标记关注') + '"></button>';
  }
  function cycleStatus(current) {
    if (!current) return 'success';
    if (current === 'success') return 'failed';
    return '';
  }
  function showStatusConditionalFields(status) {
    var sf = document.getElementById('successStatusFields');
    var ff = document.getElementById('failedStatusFields');
    if (!sf || !ff) return;
    sf.classList.toggle('visible', status === 'success');
    ff.classList.toggle('visible', status === 'failed');
  }

  function getWeekTotal(map,month){const ref=month?new Date(month+'-01'):new Date();const dow=ref.getDay();const diff=dow===0?6:dow-1;const mon=new Date(ref);mon.setDate(ref.getDate()-diff);const ms=mon.getFullYear()+'-'+String(mon.getMonth()+1).padStart(2,'0')+'-'+String(mon.getDate()).padStart(2,'0');const end=month?new Date(ref.getFullYear(),ref.getMonth()+1,0):new Date();const es=end.getFullYear()+'-'+String(end.getMonth()+1).padStart(2,'0')+'-'+String(end.getDate()).padStart(2,'0');const tsNow=getTodayStr();const ts=month&&month!==getCurrentMonth()?es:tsNow;let s=0;for(let[d,v]of Object.entries(map))if(d>=ms&&d<=ts)s+=v;return s;}
  function getMonthTotal(map,month){const p=month||getTodayStr().slice(0,7);let s=0;for(let[d,v]of Object.entries(map))if(d.startsWith(p))s+=v;return s;}
  let calendarMonth=getCurrentMonth();

  // ==================== 云端 API ====================
  async function cloudGet(date){try{const r=await fetch('/api/data?date='+date);if(r.ok)return await r.json();}catch(e){}return null;}
  async function cloudSave(data){try{await fetch('/api/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});}catch(e){}}

  // ==================== 白名单 ====================
  let whitelistCompanies = [];
  let whitelistLoaded = false;
  const whitelistSet = new Set();
  const whitelistMap = new Map();

  function updateWhitelistSet() {
    whitelistSet.clear();
    whitelistMap.clear();
    whitelistCompanies.forEach(c => {
      const bank = c.bank_name || '建行建易贷';
      const status = c.status || '正常';
      const val = { bank, status };
      const name = (c.company_name || '').trim().toLowerCase();
      if (name) {
        whitelistSet.add(name);
        whitelistMap.set(name, val);
      }
      const alias = (c.alias || '').trim().toLowerCase();
      if (alias) {
        whitelistSet.add(alias);
        whitelistMap.set(alias, val);
      }
    });
  }

  function fuzzyMatch(text, query) {
    if (!text) return false;
    text = text.toLowerCase().trim();
    query = query.toLowerCase().trim();
    if (!query) return true;
    if (text.includes(query)) return true;
    const keywords = query.split(/\s+/).filter(Boolean);
    if (keywords.length > 1) {
      return keywords.every(kw => text.includes(kw));
    }
    const escapedQuery = query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\\\$&');
    const chars = escapedQuery.split('');
    const regexStr = chars.join('.*');
    try {
      const regex = new RegExp(regexStr, 'i');
      return regex.test(text);
    } catch (e) {
      return false;
    }
  }

  function copyTextToClipboard(el) {
    const text = (el.textContent || el.innerText || '').trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(function() {
      var original = el.textContent;
      el.textContent = '已复制';
      el.style.opacity = '0.6';
      setTimeout(function() {
        el.textContent = original;
        el.style.opacity = '1';
      }, 800);
    }).catch(function() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }
  window.copyTextToClipboard = copyTextToClipboard;

  function getWhitelistTagHtml(company, isTbl) {
    if (!company || company === '-') return isTbl ? '-' : '';
    const key = String(company).trim().toLowerCase();
    
    let matchedName = null;
    let val = null;
    
    if (whitelistSet.has(key)) {
      matchedName = key;
      val = whitelistMap.get(key);
    } else {
      // Fuzzy match: check if clean name matches (excluding common suffixes/prefixes)
      const cleanCard = key.replace(/(有限公司|有限责任公司|公司|集团|深圳市|广州市|北京市|上海市|深圳|广州|北京|上海)/g, '').trim();
      if (cleanCard.length >= 2) {
        for (let wlName of whitelistSet.keys()) {
          const cleanWl = wlName.replace(/(有限公司|有限责任公司|公司|集团|深圳市|广州市|北京市|上海市|深圳|广州|北京|上海)/g, '').trim();
          if (cleanWl.length >= 2 && (cleanCard.includes(cleanWl) || cleanWl.includes(cleanCard))) {
            matchedName = wlName;
            val = whitelistMap.get(wlName);
            break;
          }
        }
      }
    }
    if (val && (val.status === '已失效' || val.status === '已删除')) {
      matchedName = null;
      val = null;
    }

    if (!matchedName || !val) {
      return isTbl ? esc(company) : '<span class="client-card-tag client-card-tag-company" style="cursor:pointer" title="点击复制单位名称" onclick="event.stopPropagation();copyTextToClipboard(this)">' + esc(company) + '</span>';
    }

    const bank = val.bank || '建行建易贷';
    const bankShort = bank.replace('建行', '').replace('建设银行', '') || bank;
    const status = val.status || '正常';
    let bankBadgeStyle = 'background:var(--accent-wechat-bg); color:var(--accent-wechat); border-color:rgba(90,106,126,0.3);';
    let bankLabel = bankShort;
    if (status === '已失效') {
      bankBadgeStyle = 'background:rgba(120,120,120,0.12); color:#95a5a6; border-color:rgba(120,120,120,0.25);';
      bankLabel = bankShort + '(已失效)';
    } else if (status === '已删除') {
      bankBadgeStyle = 'background:rgba(231,76,60,0.1); color:#e74c3c; border-color:rgba(231,76,60,0.2);';
      bankLabel = bankShort + '(已删除)';
    }
    if (isTbl) {
      // Table: keep combined label
      let label = bank + ': ' + company;
      if (status === '已失效') label = bank + '(已失效): ' + company;
      else if (status === '已删除') label = bank + '(已删除): ' + company;
      return '<span class="tbl-tag tbl-tag-company" style="' + bankBadgeStyle + '">' + esc(label) + '</span>';
    }
    // Card: company name + separate bank badge
    return '<span class="client-card-tag client-card-tag-company" style="cursor:pointer" title="点击复制单位名称" onclick="event.stopPropagation();copyTextToClipboard(this)">' + esc(company) + '</span>' +
      '<span class="client-card-tag client-card-tag-bank" style="' + bankBadgeStyle + '">' + esc(bankLabel) + '</span>';
  }

  function fetchWhitelist() {
    return fetch('/api/whitelist/companies')
      .then(r => {
        if (!r.ok) throw new Error('获取白名单失败');
        return r.json();
      })
      .then(data => {
        whitelistCompanies = data.companies || [];
        whitelistLoaded = true;
        updateWhitelistSet();
        updateWhitelistStatus();
        renderWhitelistCompanyList();
        
        // Re-render client lists to show whitelist checkmarks
        renderClientList();
        const modal = document.getElementById('allClientsModal');
        if (modal && modal.classList.contains('active')) {
          loadAllClients();
        }
        return whitelistCompanies;
      })
      .catch(err => {
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
    .then(async r => {
      if (!r.ok) {
        let msg = '上传白名单失败';
        try {
          const data = await r.json();
          if (data && data.error) msg += ': ' + data.error;
        } catch(e) {}
        throw new Error(msg);
      }
      return r.json();
    });
  }


  function updateWhitelistStatus() {
    const el = document.getElementById('whitelistStatus');
    if (el) {
      el.textContent = '已加载 ' + whitelistCompanies.length + ' 家白名单企业';
    }
  }

  function handleFailedUploads(companies) {
    try {
      const failed = JSON.parse(localStorage.getItem('whitelist_failed_uploads') || '[]');
      const failedSet = new Set(failed);
      companies.forEach(c => failedSet.add(c));
      localStorage.setItem('whitelist_failed_uploads', JSON.stringify(Array.from(failedSet)));
      renderFailedUploadsArea();
    } catch (e) {
      console.error('Failed to save failed whitelist uploads:', e);
    }
  }

  function renderFailedUploadsArea() {
    const container = document.getElementById('whitelistFailedArea');
    const listEl = document.getElementById('whitelistFailedList');
    const countEl = document.getElementById('whitelistFailedCount');
    if (!container || !listEl || !countEl) return;

    let failed = [];
    try {
      failed = JSON.parse(localStorage.getItem('whitelist_failed_uploads') || '[]');
    } catch (e) {}

    if (failed.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    countEl.textContent = failed.length;
    listEl.textContent = failed.map(c => {
      if (typeof c === 'string') return c;
      return c.company_name + (c.status && c.status !== '正常' ? ',' + c.status : '');
    }).join('\\n');
  }

  function renderWhitelistCompanyList() {
    const container = document.getElementById('whitelistCompanyList');
    if (!container) return;

    const searchInput = document.getElementById('whitelistModalSearchInput');
    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

    let filtered = whitelistCompanies;
    if (query) {
      filtered = whitelistCompanies.filter(c => {
        return fuzzyMatch(c.company_name, query) || fuzzyMatch(c.alias, query);
      });
    }

    if (filtered.length === 0) {
      container.innerHTML = '<div style="font-size:0.7rem; color:var(--text-light); text-align:center; padding:10px;">' + (query ? '无匹配搜索的企业' : '暂无白名单企业数据') + '</div>';
      return;
    }

    let html = '';
    filtered.forEach(c => {
      html += '<div class="whitelist-company-item">' +
        '<span style="font-size:0.72rem; font-weight:700; color:var(--text-main);">' + esc(c.company_name) + '</span>' +
        '</div>';
    });
    container.innerHTML = html;
  }

  function initWhitelistFeature() {
    const whitelistBtn = document.getElementById('whitelistMenuBtn');
    const whitelistModal = document.getElementById('whitelistModal');
    const closeBtn = document.getElementById('closeWhitelistBtn');
    const uploadBtn = document.getElementById('whitelistUploadBtn');
    const refreshBtn = document.getElementById('whitelistRefreshBtn');
    const textarea = document.getElementById('whitelistTextarea');
    const failedClearBtn = document.getElementById('whitelistFailedClearBtn');
    const failedRetryBtn = document.getElementById('whitelistFailedRetryBtn');
    const modalSearch = document.getElementById('whitelistModalSearchInput');
    const fileInput = document.getElementById('whitelistFileInput');
    const templateBtn = document.getElementById('whitelistTemplateBtn');

    if (whitelistBtn && whitelistModal) {
      whitelistBtn.addEventListener('click', () => {
        whitelistModal.classList.add('active');
        renderFailedUploadsArea();
        if (!whitelistLoaded) {
          fetchWhitelist();
        }
      });
    }

    if (closeBtn && whitelistModal) {
      closeBtn.addEventListener('click', () => {
        whitelistModal.classList.remove('active');
      });
      whitelistModal.addEventListener('click', e => {
        if (e.target === whitelistModal) {
          whitelistModal.classList.remove('active');
        }
      });
    }

    if (uploadBtn && textarea) {
      uploadBtn.addEventListener('click', () => {
        const text = textarea.value.trim();
        if (!text) { alert('请先粘贴企业名称'); return; }
        const companies = text.split('\\n')
          .map(s => s.trim())
          .filter(s => s.length > 0)
          .map(s => {
            const parts = s.split(',');
            if (parts.length > 1) {
              return {
                company_name: parts[0].trim(),
                status: parts[1].trim()
              };
            }
            return {
              company_name: s,
              status: '正常'
            };
          });
        if (companies.length === 0) { alert('请至少输入一个企业名称'); return; }

        uploadBtn.textContent = '上传中...';
        uploadBtn.disabled = true;
        uploadWhitelist(companies)
          .then(result => {
            alert('成功上传 ' + result.count + ' 家企业到白名单');
            textarea.value = '';
            return fetchWhitelist();
          })
          .catch(err => {
            alert('上传失败：' + err.message + '。已存入本地失败重试列表。');
            handleFailedUploads(companies);
          })
          .then(() => {
            uploadBtn.textContent = '上传白名单';
            uploadBtn.disabled = false;
          });
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        fetchWhitelist();
      });
    }

    if (modalSearch) {
      modalSearch.addEventListener('input', () => {
        renderWhitelistCompanyList();
      });
    }

    if (failedClearBtn) {
      failedClearBtn.addEventListener('click', e => {
        e.preventDefault();
        localStorage.removeItem('whitelist_failed_uploads');
        renderFailedUploadsArea();
      });
    }

    if (failedRetryBtn) {
      failedRetryBtn.addEventListener('click', () => {
        let failed = [];
        try {
          failed = JSON.parse(localStorage.getItem('whitelist_failed_uploads') || '[]');
        } catch (e) {}
        if (failed.length === 0) return;

        failedRetryBtn.textContent = '重试中...';
        failedRetryBtn.disabled = true;
        uploadWhitelist(failed)
          .then(result => {
            alert('重新上传成功，共导入 ' + result.count + ' 家企业');
            localStorage.removeItem('whitelist_failed_uploads');
            renderFailedUploadsArea();
            return fetchWhitelist();
          })
          .catch(err => {
            alert('重试上传依然失败: ' + err.message);
          })
          .then(() => {
            failedRetryBtn.textContent = '尝试重新上传';
            failedRetryBtn.disabled = false;
          });
      });
    }

    if (templateBtn) {
      templateBtn.addEventListener('click', (e) => {
        e.preventDefault();
        // 创建工作簿
        const wb = XLSX.utils.book_new();
        // 表头和示例数据
        const data = [
          ['单位全称', '操作'],
          ['示例：中国石油化工集团公司', ''],
          ['示例：国家电网有限公司', ''],
          ['示例：中国工商银行股份有限公司', '新增'],
        ];
        const ws = XLSX.utils.aoa_to_sheet(data);
        // 设置列宽
        ws['!cols'] = [{ wch: 40 }, { wch: 15 }];
        XLSX.utils.book_append_sheet(wb, ws, '客户导入模板');
        // 触发下载
        XLSX.writeFile(wb, '客户导入模板.xlsx');
      });
    }

    if (fileInput && textarea) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const data = new Uint8Array(evt.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            let allLines = [];

            workbook.SheetNames.forEach(sheetName => {
              const worksheet = workbook.Sheets[sheetName];
              const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
              if (rows.length === 0) return;

              let defaultStatus = '正常';
              if (sheetName.includes('失效')) {
                defaultStatus = '已失效';
              } else if (sheetName.includes('删除')) {
                defaultStatus = '已删除';
              }

              const headerRow = rows[0] || [];
              let targetColIndex = -1;
              let opColIndex = -1;
              const exactKeywords = ["单位全称", "公司名称", "企业名称", "单位名称", "公司全称", "企业全称"];
              const secondaryKeywords = ["公司", "单位", "企业", "名称", "白名单", "简称"];
              const excludeKeywords = ["行业", "性质", "账号", "代码", "等级", "类别", "类型"];

              // First try exact match
              for (let i = 0; i < headerRow.length; i++) {
                const val = String(headerRow[i] || '').trim();
                if (exactKeywords.includes(val)) {
                  targetColIndex = i;
                  break;
                }
              }

              // If not found, try secondary keywords excluding noise columns
              if (targetColIndex === -1) {
                for (let i = 0; i < headerRow.length; i++) {
                  const val = String(headerRow[i] || '').trim();
                  const hasExclude = excludeKeywords.some(ex => val.includes(ex));
                  if (!hasExclude && secondaryKeywords.some(kw => val.includes(kw))) {
                    targetColIndex = i;
                    break;
                  }
                }
              }

              // Find operation / status column (prefer "操作" over "状态")
              for (let i = 0; i < headerRow.length; i++) {
                const val = String(headerRow[i] || '').trim();
                if (val.includes("操作")) {
                  opColIndex = i;
                  break;
                }
              }
              if (opColIndex === -1) {
                for (let i = 0; i < headerRow.length; i++) {
                  const val = String(headerRow[i] || '').trim();
                  if (val.includes("状态")) {
                    opColIndex = i;
                    break;
                  }
                }
              }

              const finalColIndex = targetColIndex !== -1 ? targetColIndex : 0;
              const startRow = targetColIndex !== -1 ? 1 : 0;
              for (let r = startRow; r < rows.length; r++) {
                const row = rows[r] || [];
                const cellVal = String(row[finalColIndex] || '').trim();
                if (cellVal && cellVal.length > 1) {
                  let status = defaultStatus;
                  if (opColIndex !== -1 && row[opColIndex]) {
                    const opVal = String(row[opColIndex]).trim();
                    if (opVal.includes("失效")) {
                      status = '已失效';
                    } else if (opVal.includes("删除")) {
                      status = '已删除';
                    } else if (opVal.includes("新增") || opVal.includes("修改") || opVal.includes("通过")) {
                      status = '正常';
                    }
                  }
                  
                  if (status === '正常') {
                    allLines.push(cellVal);
                  } else {
                    allLines.push(cellVal + ',' + status);
                  }
                }
              }
            });

            const uniqueLines = Array.from(new Set(allLines));
            if (uniqueLines.length > 0) {
              const currentVal = textarea.value.trim();
              const suffix = currentVal ? '\\n' : '';
              textarea.value = currentVal + suffix + uniqueLines.join('\\n');
              alert('成功从表格中读取 ' + uniqueLines.length + ' 家公司，已自动标记已失效或已删除的记录（格式如：“公司名,已失效”）。请确认后点击下方的“上传白名单”进行保存。');
            } else {
              alert('未能在表格中识别到公司名称，请确保表格中包含“单位全称”、“公司名称”或“企业名称”字样的表头。');
            }
          } catch (err) {
            console.error(err);
            alert('解析表格失败: ' + err.message);
          } finally {
            fileInput.value = '';
          }
        };
        reader.readAsArrayBuffer(file);
      });
    }

    // Whitelist search on the main dashboard
    const mainSearchInput = document.getElementById('mainWlSearchInput');
    const mainSearchResults = document.getElementById('mainWlSearchResults');
    if (mainSearchInput && mainSearchResults) {
      document.addEventListener('click', e => {
        if (!mainSearchInput.contains(e.target) && !mainSearchResults.contains(e.target)) {
          mainSearchResults.style.display = 'none';
        }
      });
      mainSearchInput.addEventListener('input', () => {
        const query = mainSearchInput.value.toLowerCase().trim();
        if (!query) {
          mainSearchResults.style.display = 'none';
          mainSearchResults.innerHTML = '';
          return;
        }

        const matched = whitelistCompanies.filter(c => {
          return fuzzyMatch(c.company_name, query) || fuzzyMatch(c.alias, query);
        });

        // Limit results to 15
        const limitMatches = matched.slice(0, 15);
        if (limitMatches.length === 0) {
          mainSearchResults.innerHTML = '<div style="color:var(--text-light); text-align:center; padding:6px; font-style:italic;">无匹配企业</div>';
        } else {
          mainSearchResults.innerHTML = limitMatches.map(c => {
            const bank = c.bank_name || '建行建易贷';
            const status = c.status || '正常';
            let label = bank;
            let badgeStyle = 'background:var(--accent-wechat-bg); color:var(--accent-wechat);';
            if (status === '已失效') {
              label = bank + '(已失效)';
              badgeStyle = 'background:rgba(120,120,120,0.1); color:#7f8c8d;';
            } else if (status === '已删除') {
              label = bank + '(已删除)';
              badgeStyle = 'background:rgba(231,76,60,0.1); color:#e74c3c;';
            }
            return '<div class="wl-result-item" style="display:flex; justify-content:space-between; align-items:center; padding:4px 6px; border-bottom:1px dashed var(--card-border); background:var(--btn-bg); border-radius:3px; cursor:pointer;" data-company="' + esc(c.company_name) + '">' +
              '<span style="font-weight:700; color:var(--text-main); font-size:0.62rem;">' + esc(c.company_name) + '</span>' +
              '<span style="font-size:0.52rem; ' + badgeStyle + ' padding:1px 4px; border-radius:3px; font-weight:700; white-space:nowrap; margin-left:8px;">' + esc(label) + '</span>' +
              '</div>';
          }).join('');
        }
        mainSearchResults.style.display = 'flex';
      });
      // 点击白名单结果：填充到意向登记和临时登记的单位名称
      mainSearchResults.addEventListener('click', function(e) {
        var item = e.target.closest('.wl-result-item');
        if (!item) return;
        var company = item.dataset.company;
        var custEl = document.getElementById('custCompany');
        var tempEl = document.getElementById('tempCustCompany');
        if (custEl) custEl.value = company;
        if (tempEl) tempEl.value = company;
        mainSearchResults.style.display = 'none';
        mainSearchInput.value = '';
      });
    }

    renderFailedUploadsArea();
    fetchWhitelist(); // Load on page load
  }


  // ==================== Outbox 队列（Office式同步）====================
  // 每次操作先写入队列（localStorage），再发网。关页也不丢，下次打开继续补发。
  const loadOpQueue=()=>{try{return JSON.parse(localStorage.getItem(OP_QUEUE_K))||[];}catch(e){return[];}};
  const saveOpQueue=q=>localStorage.setItem(OP_QUEUE_K,JSON.stringify(q));
  let _draining=false;
  async function drainQueue(){
    if(_draining)return;
    _draining=true;
    _syncStatus='syncing';updateSyncIndicator();
    try{
      let anyOk=false;
      while(true){
        const q=loadOpQueue();
        if(q.length===0)break;
        const item=q[0];
        const {_qid,...body}=item;
        let ok=false;
        let status=0;
        let errMsg='';
        if(!item._retry)item._retry=0;
        try{
          const r=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
          status=r.status;
          if(r.ok){const d=await r.json();if(d._ts)localStorage.setItem(LOCAL_TS_K,d._ts);ok=true;anyOk=true;}
          else{errMsg='HTTP '+r.status;}
        }catch(e){errMsg=e.message||'网络连接错误';}
        if(ok){
          saveOpQueue(loadOpQueue().filter(function(i){return i._qid!==_qid;}));
          updateSyncIndicator();
        }else{
          if(status>=400&&status<500){
            addSyncLog('⚠️ 放弃无效操作 ['+item.op+']: '+errMsg);
            saveOpQueue(loadOpQueue().filter(function(i){return i._qid!==_qid;}));
            updateSyncIndicator();
            continue;
          }
          item._retry++;
          if(item._retry>=5){
            addSyncLog('❌ 操作 ['+item.op+'] 重试 5 次失败已丢弃: '+errMsg);
            saveOpQueue(loadOpQueue().filter(function(i){return i._qid!==_qid;}));
            updateSyncIndicator();
            continue;
          }
          const currentQueue=loadOpQueue();
          const currentItemIdx=currentQueue.findIndex(function(i){return i._qid===_qid;});
          if(currentItemIdx>=0){
            currentQueue[currentItemIdx]._retry=item._retry;
            saveOpQueue(currentQueue);
          }
          _syncStatus='pending';updateSyncIndicator();
          break;
        }
      }
      if(loadOpQueue().length===0){_syncStatus='synced';if(anyOk){_lastSyncTime=new Date();addSyncLog('✅ 增量队列推送云端成功');}}
    }finally{_draining=false;updateSyncIndicator();}
  }
  // 每次操作：先写队列（持久化），再尝试发送
  async function syncOp(op,payload,customDate){
    const targetDate=customDate||getTodayStr();
    const item={_qid:Date.now()+'_'+Math.random().toString(36).slice(2),date:targetDate,op,...payload};
    const q=loadOpQueue();q.push(item);saveOpQueue(q);
    await drainQueue();
  }
  async function cloudCalendar(month){try{const r=await fetch('/api/calendar?month='+month);if(r.ok)return await r.json();}catch(e){}return null;}
  async function cloudStats(month){try{const r=await fetch('/api/stats?month='+month);if(r.ok)return await r.json();}catch(e){}return null;}

  // ==================== 同步状态指示器 ====================
  let _lastSyncTime=null;
  let _syncStatus='syncing';
  function updateSyncIndicator(){
    var btn=document.getElementById('syncBtn');
    var icon=document.getElementById('syncIcon');
    var label=document.getElementById('syncLabel');
    var tip=document.getElementById('syncTooltip');
    if(!btn)return;
    var q=loadOpQueue();
    var qLen=q.length;
    var st=_syncStatus;
    if(!navigator.onLine)st='offline';
    if(st!=='syncing'&&st!=='error'&&st!=='offline'){st=qLen>0?'pending':'synced';}
    btn.className='sync-indicator '+st;
    if(st==='syncing'){
      icon.textContent='⇅';label.textContent='同步中...';
    }else if(st==='offline'){
      icon.textContent='🔌';label.textContent='离线模式';
    }else if(st==='pending'){
      icon.textContent='⇅';label.innerHTML='<span class="sync-badge">'+qLen+'</span> 待同步';
    }else if(st==='error'){
      icon.textContent='⇅';label.textContent='同步失败';
    }else{
      icon.textContent='⇅';label.textContent='已同步';
    }
    var timeStr='--:--';
    if(_lastSyncTime){
      var hh=String(_lastSyncTime.getHours()).padStart(2,'0');
      var mm=String(_lastSyncTime.getMinutes()).padStart(2,'0');
      var ss=String(_lastSyncTime.getSeconds()).padStart(2,'0');
      timeStr=hh+':'+mm+':'+ss;
    }
    tip.textContent='\u{1F552} '+timeStr+(qLen>0?' | 队列: '+qLen+'\u6761':'');
  }

  // 保存当前完整状态到 KV
  async function saveFullState(full){
    const today=getTodayStr();
    const wm=loadMap(WECHAT_K);
    const rm=loadMap(REVISIT_K);
    const vm=loadMap(VISIT_K);
    const pm=loadMap(PAYMENT_K);
    const allClients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const webhookUrl=localStorage.getItem('webhook_url')||'';

    if(full){
      const scripts=loadScripts();
      const learns=loadLearns();
      const dates = new Set([...Object.keys(wm), ...Object.keys(rm), ...Object.keys(vm), ...Object.keys(pm), ...allClients.map(c=>c.date).filter(Boolean), today]);
      const ts = Date.now();
      const payload = [];
      for(const d of dates){
        const dClients=allClients.filter(c=>c.date===d);
        const item = {
          date:d,
          wechatCount:wm[d]||0,
          intentCount:dClients.length,
          revisitCount:rm[d]||0,
          visitCount:vm[d]||0,
          paymentCount:pm[d]||0,
          clients:dClients,
          webhookUrl:webhookUrl,
          _ts:ts
        };
        if(d===today){
          item.todayTodos=loadTodos(TODAY_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today);
          item.tomorrowTodos=loadTodos(TOMORROW_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today);
          item.tempClients=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
          item.scripts=scripts;
          item.learns=learns;
        }
        payload.push(item);
      }
      localStorage.setItem(LOCAL_TS_K,ts);
      await cloudSave(payload);
      addSyncLog('✅ 手动全量历史数据同步成功');
    } else {
      const todayClients=allClients.filter(c=>c.date===today);
      const data={
        date:today,
        wechatCount:wm[today]||0,
        intentCount:todayClients.length,
        revisitCount:rm[today]||0,
        visitCount:vm[today]||0,
        paymentCount:pm[today]||0,
        clients:todayClients,
        todayTodos:loadTodos(TODAY_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today),
        tomorrowTodos:loadTodos(TOMORROW_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today),
        tempClients:JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]'),
        webhookUrl:webhookUrl,
        _ts:Date.now()
      };
      localStorage.setItem(LOCAL_TS_K,data._ts);
      await cloudSave(data);
    }
  }  // 拉取全量意向客户并同步到本地 CLIENTS_K 缓存中
  async function syncAllClientsFromCloud(){
    try {
      const r = await fetch('/api/all-clients');
      if (r.ok) {
        const cloudClients = await r.json();
        if (Array.isArray(cloudClients)) {
          const allClients = loadClients();
          const mergeMap = new Map();
          // Keep local copies first to prevent overriding unsaved local modifications
          allClients.forEach(c => {
            const key = c.date + '|' + c.name + '|' + c.phone + '|' + (c.time||'');
            mergeMap.set(key, c);
          });
          // Merge incoming cloud data
          cloudClients.forEach(c => {
            const key = c.date + '|' + c.name + '|' + c.phone + '|' + (c.time||'');
            if (!mergeMap.has(key)) {
              mergeMap.set(key, c);
            }
          });
          localStorage.setItem(CLIENTS_K, JSON.stringify([...mergeMap.values()]));
          addSyncLog('✅ 拉取并合并云端所有客户列表完成');
        }
      }
    } catch(e) {
      console.error('Failed to fetch all clients:', e);
      addSyncLog('⚠️ 拉取全量客户失败: ' + e.message);
    }
  }

  // 从 KV 拉取最新数据，如果云端更新则覆盖本地
  async function pullLatest(){
    const today=getTodayStr();
    let data=null;
    try{
      data=await cloudGet(today);
    }catch(errVal){
      addSyncLog('⚠️ 同步拉取异常: '+errVal.message);
      return;
    }
    if(!data)return;
    const localTs=parseInt(localStorage.getItem(LOCAL_TS_K)||'0');
    if((data._ts||0)>localTs){
      // 微信计数取最大值
      const wm=loadMap(WECHAT_K);
      wm[today]=Math.max(wm[today]||0, data.wechatCount||0);
      saveMap(WECHAT_K,wm);
      const im=loadMap(INTENT_K);im[today]=data.intentCount||0;saveMap(INTENT_K,im);
      // 回访计数取最大值
      const rm=loadMap(REVISIT_K);
      rm[today]=Math.max(rm[today]||0, data.revisitCount||0);
      saveMap(REVISIT_K,rm);
      // 上门计数取最大值
      const vm=loadMap(VISIT_K);
      vm[today]=Math.max(vm[today]||0, data.visitCount||0);
      saveMap(VISIT_K,vm);
      // 回款计数取最大值
      const pm=loadMap(PAYMENT_K);
      pm[today]=Math.max(pm[today]||0, data.paymentCount||0);
      saveMap(PAYMENT_K,pm);
      // 目标：云端版本为准
      if(data.goals!==undefined)saveGoals(data.goals);
      // 客户列表：合并（取并集），云端新增的保留，本地新增的也保留
      if(data.clients!==undefined){
        const allClients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
        const nonToday=allClients.filter(c=>c.date!==today);
        const localToday=allClients.filter(c=>c.date===today);
        const mergeMap=new Map();
        // 先放本地（保留本地未同步的条目）
        localToday.forEach(c=>mergeMap.set(c.name+'|'+c.phone+'|'+(c.time||''),c));
        // 再放云端（云端的备注/字段更新会覆盖同 key 的本地旧值）
        (data.clients||[]).forEach(c=>mergeMap.set(c.name+'|'+c.phone+'|'+(c.time||''),c));
        localStorage.setItem(CLIENTS_K,JSON.stringify([...nonToday,...mergeMap.values()]));
      }
      // 待办：云端版本为准（通过 setTodayTodos/setTomorrowTodos 原子同步）
      if(data.todayTodos!==undefined)saveTodos(TODAY_TODO_K,data.todayTodos);
      if(data.tomorrowTodos!==undefined)saveTodos(TOMORROW_TODO_K,data.tomorrowTodos);
      // 临时登记：云端版本合并，保留历史数据
      if(data.tempClients!==undefined){
        var allTemp=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
        var nonTodayTemp=allTemp.filter(function(tc){return tc.date!==today;});
        var localTodayTemp=allTemp.filter(function(tc){return tc.date===today;});
        var tempMergeMap=new Map();
        localTodayTemp.forEach(function(tc){tempMergeMap.set(tc.name+'|'+tc.phone+'|'+(tc.time||''),tc);});
        (data.tempClients||[]).forEach(function(tc){tempMergeMap.set(tc.name+'|'+tc.phone+'|'+(tc.time||''),tc);});
        var mergedTemp=nonTodayTemp.concat(Array.from(tempMergeMap.values()));
        // 全量去重：修复历史脏数据在同步中的重复累积
        var seenTemp=new Set();
        mergedTemp=mergedTemp.filter(function(tc){
          var k=(tc.name||'')+'|'+(tc.phone||'')+'|'+(tc.date||'')+'|'+(tc.time||'');
          if(seenTemp.has(k)) return false;
          seenTemp.add(k);
          return true;
        });
        localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(mergedTemp));
      }
      // 话术/学习
      if(data.scripts!==undefined){saveScripts(data.scripts);renderLockScripts();}
      if(data.learns!==undefined){saveLearns(data.learns);renderLockLearns();}
      // 同步 Webhook URL 并保存到本地，解耦 DOM 访问
      if(data.pinHash!==undefined&&data.pinHash)localStorage.setItem(PIN_HASH_K,data.pinHash);
      if(data.webhookUrl!==undefined)localStorage.setItem('webhook_url',data.webhookUrl);
      if(data.deepseekApiKey!==undefined)localStorage.setItem('deepseek_api_key',data.deepseekApiKey);
      if(data.aiApiKey!==undefined)localStorage.setItem('ai_api_key',data.aiApiKey);
      if(data.aiApiBase!==undefined)localStorage.setItem('ai_api_base',data.aiApiBase);
      if(data.aiModel!==undefined)localStorage.setItem('ai_model',data.aiModel);
      if(data.visionApiBase!==undefined)localStorage.setItem('vision_api_base',data.visionApiBase);
      localStorage.setItem(LOCAL_TS_K,data._ts);
      refreshAll();
      addSyncLog('✅ 拉取并合并云端最新数据完成');
    }
    _lastSyncTime=new Date();
    if(loadOpQueue().length===0)_syncStatus='synced';
    updateSyncIndicator();
  }

  // 跨天从云端恢复数据（页面加载时使用）
  async function loadFromCloud(date){
    if(!date)date=getTodayStr();
    let data=null;
    try{
      data=await cloudGet(date);
    }catch(errVal){
      addSyncLog('⚠️ 跨天数据拉取异常: '+errVal.message);
      return false;
    }
    if(!data)return false;
    const wm=loadMap(WECHAT_K);wm[date]=data.wechatCount||0;saveMap(WECHAT_K,wm);
    const im=loadMap(INTENT_K);im[date]=data.intentCount||0;saveMap(INTENT_K,im);
    const rm=loadMap(REVISIT_K);rm[date]=data.revisitCount||0;saveMap(REVISIT_K,rm);
    const vm=loadMap(VISIT_K);vm[date]=data.visitCount||0;saveMap(VISIT_K,vm);
    const pm=loadMap(PAYMENT_K);pm[date]=data.paymentCount||0;saveMap(PAYMENT_K,pm);
    if(data.goals!==undefined)saveGoals(data.goals);
    if(data.clients!==undefined){
      const all=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      const nonDay=all.filter(c=>c.date!==date);
      localStorage.setItem(CLIENTS_K,JSON.stringify([...nonDay,...(data.clients||[])]));
    }
    if(data.todayTodos!==undefined)saveTodos(TODAY_TODO_K,data.todayTodos);
    if(data.tomorrowTodos!==undefined)saveTodos(TOMORROW_TODO_K,data.tomorrowTodos);
    if(data.tempClients!==undefined){
      var allTemp2=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
      var nonDayTemp=allTemp2.filter(function(tc){return tc.date!==date;});
      var dayTempMerge=new Map();
      var localDayTemp=allTemp2.filter(function(tc){return tc.date===date;});
      localDayTemp.forEach(function(tc){dayTempMerge.set(tc.name+'|'+tc.phone+'|'+(tc.time||''),tc);});
      (data.tempClients||[]).forEach(function(tc){dayTempMerge.set(tc.name+'|'+tc.phone+'|'+(tc.time||''),tc);});
      var mergedDayTemp=nonDayTemp.concat(Array.from(dayTempMerge.values()));
      // 全量去重：修复历史脏数据在同步中的重复累积
      var seenDayTemp=new Set();
      mergedDayTemp=mergedDayTemp.filter(function(tc){
        var k=(tc.name||'')+'|'+(tc.phone||'')+'|'+(tc.date||'')+'|'+(tc.time||'');
        if(seenDayTemp.has(k)) return false;
        seenDayTemp.add(k);
        return true;
      });
      localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(mergedDayTemp));
    }
    if(data.scripts!==undefined)saveScripts(data.scripts);
    if(data.learns!==undefined)saveLearns(data.learns);
    if(data.pinHash!==undefined&&data.pinHash)localStorage.setItem(PIN_HASH_K,data.pinHash);
    if(data.webhookUrl!==undefined)localStorage.setItem('webhook_url',data.webhookUrl);
    if(data.deepseekApiKey!==undefined)localStorage.setItem('deepseek_api_key',data.deepseekApiKey);
    if(data.aiApiKey!==undefined)localStorage.setItem('ai_api_key',data.aiApiKey);
    if(data.aiApiBase!==undefined)localStorage.setItem('ai_api_base',data.aiApiBase);
    if(data.aiModel!==undefined)localStorage.setItem('ai_model',data.aiModel);
    if(data.visionApiBase!==undefined)localStorage.setItem('vision_api_base',data.visionApiBase);
    if(data.lastLoadDate)localStorage.setItem(LAST_LOAD_DATE_K,data.lastLoadDate);
    localStorage.setItem(LOCAL_TS_K,data._ts||Date.now());
    return true;
  }

  // ==================== 每日自动检查 ====================
  // 保留函数供手动/定时调用，首次加载在 init 中内联处理
  function autoDailyReset(){
    const todayStr=getTodayStr();
    const lastLoadDate=localStorage.getItem(LAST_LOAD_DATE_K);
    if(lastLoadDate&&lastLoadDate!==todayStr){
      const tomorrow=loadTodos(TOMORROW_TODO_K);
      if(tomorrow.length>0){
        const today=loadTodos(TODAY_TODO_K);
        saveTodos(TODAY_TODO_K,[...tomorrow,...today]);
        saveTodos(TOMORROW_TODO_K,[]);
        console.log('📅 已自动将前一天待办转移到今天');
      }
      localStorage.setItem(LAST_LOAD_DATE_K,todayStr);
    }
  }

  // ==================== 渲染 ====================
  // 解析「[日期 时间] 内容」多行跟进记录文本：含时间戳行时还原为多条记录（保留原日期时间），
  // 无时间戳的纯文本保持旧 followUp 字段格式（避免把历史多条记录折叠成一条、日期时间全丢）
  function splitFollowUpsText(raw) {
    raw=(raw||'').trim();
    if(!raw)return {followUps:[],followUp:''};
    var lines=raw.split('\\n');
    var re=/^\\[\\s*(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*\\]\\s*(.*)$/;
    var followUps=[];
    var pending=null;
    for(var i=0;i<lines.length;i++){
      var m=lines[i].match(re);
      if(m){
        if(pending)followUps.push(pending);
        pending={date:m[1],time:m[2],content:m[3]};
      }else if(pending){
        pending.content+=(pending.content?'\\n':'')+lines[i];
      }else if(lines[i].trim()){
        followUps.push({date:'',time:'',content:lines[i]});
      }
    }
    if(pending)followUps.push(pending);
    var hasTimestamp=followUps.some(function(f){return !!(f.date&&f.time);});
    if(hasTimestamp)return {followUps:followUps,followUp:''};
    return {followUps:[],followUp:raw};
  }

  function renderClientList(){
    // 保护编辑中的跟进记录：重绘前保存已展开的内联表单（内容/焦点），重绘后按客户身份恢复。
    // 否则 60 秒定时刷新/15 秒云同步/切回标签触发的重绘会清空正在输入的记录
    const _c0=document.getElementById('clientList');
    const _openForms=[];
    if(_c0){
      _c0.querySelectorAll('.client-card-item').forEach(function(_card){
        const _form=_card.querySelector('.cl-followup-inline-form');
        if(!_form||_form.style.display!=='block')return;
        const _ne=_card.querySelector('.client-card-name');
        const _pe=_card.querySelector('.client-phone');
        const _te=_card.querySelector('.client-card-time');
        const _ta=_card.querySelector('.cl-followup-inline-input');
        _openForms.push({key:(_ne?_ne.textContent:'')+'|'+( _pe?_pe.dataset.full:'')+'|'+( _te?_te.textContent:''),value:_ta?_ta.value:'',focus:!!(_ta&&document.activeElement===_ta)});
      });
    }
    const today=getTodayStr();
    const clients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]').filter(c=>c.date===today);
    const container = document.getElementById('clientList');
    if(!container)return;
    if(clients.length===0){
      container.innerHTML='<div class="empty-clients">暂无意向客户</div>';
      return;
    }
    container.innerHTML=clients.map((c,i)=>{
      var statusCls = c.status ? ' ' + STATUS_CLASSES[c.status] : '';
      return '<div class="client-card-item' + statusCls + '">'+
        '<div class="client-card-top">'+
          '<div class="client-card-primary">'+
            '<span class="client-card-name">'+esc(c.name)+'</span>'+
            '<span class="client-card-phone-wrap">'+
              '<a class="client-phone" href="tel:'+esc(c.phone)+'" data-full="'+esc(c.phone)+'">'+esc(maskPhone(c.phone))+'</a>'+
              '<button class="phone-toggle" title="显示号码">看</button>'+
            '</span>'+
          '</div>'+
          (c.time ? '<span class="client-card-time">'+esc(c.time)+'</span>' : '')+
        '</div>'+
        getStatusBadgeHtml(c) +
        '<div class="client-card-tags">'+
          (c.label ? '<span class="client-card-tag client-card-tag-grade-' + esc(c.label).toLowerCase() + '">' + esc(c.label) + '类客户</span>' : '')+
          (c.company ? getWhitelistTagHtml(c.company, false) : '')+
          (c.fund ? '<span class="client-card-tag client-card-tag-fund">公积金: '+esc(c.fund)+'</span>' : '')+
          getClientDetailTags(c) +
        '</div>'+
        '<div class="client-card-body">'+
          '<div class="client-card-content-block">'+
            '<span class="client-card-label">沟通记录</span>'+
            '<span class="client-card-text">'+esc(c.note||'')+'</span>'+
          '</div>'+
          '<div class="client-card-content-block follow-up">'+
            '<div style="display:flex;justify-content:space-between;align-items:center;">'+
              '<span class="client-card-label">跟进记录('+(c.followUps?c.followUps.length:0)+')</span>'+
              '<button class="cl-add-followup-btn" data-idx="'+i+'" title="新增跟进记录" style="font-size:0.9rem;width:24px;height:24px;border:none;background:transparent;color:var(--accent-wechat);cursor:pointer;font-weight:700;line-height:1;display:flex;align-items:center;justify-content:center;">+</button>'+
            '</div>'+
            (c.followUps && c.followUps.length > 0 ?
              '<div class="follow-up-list">'+
                c.followUps.map(function(fu){ return '<div class="follow-up-record">'+(fu.date||fu.time?'<div class="follow-up-record-header">'+esc(fu.date||'')+' '+esc(fu.time||'')+'</div>':'')+'<div class="follow-up-record-text">'+esc(fu.content||'')+'</div></div>'; }).join('')+
              '</div>' : (c.followUp ?
              '<span class="client-card-text">'+esc(c.followUp)+'</span>' : ''))+
            '<div class="cl-followup-inline-form" style="display:none;margin-top:6px;">'+
              '<textarea class="cl-followup-inline-input" placeholder="新增跟进记录..." style="width:100%;min-height:44px;padding:6px 8px;font-size:0.78rem;resize:vertical;border:1px solid var(--card-border);border-radius:6px;background:var(--input-bg);color:var(--text-main);font-family:inherit;box-sizing:border-box;"></textarea>'+
              '<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:4px;">'+
                '<button class="cl-followup-save-btn" data-idx="'+i+'" style="font-size:0.7rem;padding:3px 10px;background:var(--accent-btn);color:#fff;border:none;border-radius:4px;font-weight:700;cursor:pointer;">保存</button>'+
                '<button class="cl-followup-cancel-btn" style="font-size:0.7rem;padding:3px 10px;background:var(--btn-bg);color:var(--text-soft);border:1px solid var(--card-border);border-radius:4px;font-weight:700;cursor:pointer;">取消</button>'+
              '</div>'+
            '</div>'+
          '</div>'+
          (c.demand ?
            '<div class="client-card-content-block">'+
              '<span class="client-card-label">客户需求</span>'+
              '<span class="client-card-text">'+esc(c.demand)+'</span>'+
            '</div>' : '')+
          (c.fundUsage ?
            '<div class="client-card-content-block">'+
              '<span class="client-card-label">资金用途</span>'+
              '<span class="client-card-text">'+esc(c.fundUsage)+'</span>'+
            '</div>' : '')+
        '</div>'+
        '<div class="client-card-actions">'+
          getStatusToggleHtml(c) +
          '<button class="export-single-btn" data-name="'+esc(c.name)+'" data-phone="'+esc(c.phone)+'" data-time="'+esc(c.time||'')+'" title="导出"><svg width="15" height="15" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l7.5-7.5M5.5 5H12v6.5"/></svg></button>'+
          '<button class="edit-icon" data-name="'+esc(c.name)+'" data-phone="'+esc(c.phone)+'" data-time="'+esc(c.time||'')+'" title="编辑"><svg width="15" height="15" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 3l2 2L6 13.5H3.5v-2.5L11.5 3z"/></svg></button>'+
          '<button class="del-icon" data-name="'+esc(c.name)+'" data-phone="'+esc(c.phone)+'" data-time="'+esc(c.time||'')+'" title="删除">×</button>'+
        '</div>'+
      '</div>';
    }).join('');

    // 恢复重绘前展开的跟进记录输入框（内容/展开状态/焦点），使自动刷新不打断编辑
    _openForms.forEach(function(_f){
      const _cards=container.querySelectorAll('.client-card-item');
      for(let _i=0;_i<_cards.length;_i++){
        const _card=_cards[_i];
        const _ne=_card.querySelector('.client-card-name');
        const _pe=_card.querySelector('.client-phone');
        const _te=_card.querySelector('.client-card-time');
        const _key=(_ne?_ne.textContent:'')+'|'+( _pe?_pe.dataset.full:'')+'|'+( _te?_te.textContent:'');
        if(_key!==_f.key)continue;
        const _form=_card.querySelector('.cl-followup-inline-form');
        const _ta=_card.querySelector('.cl-followup-inline-input');
        if(_form)_form.style.display='block';
        if(_ta){_ta.value=_f.value;if(_f.focus){_ta.focus();try{_ta.setSelectionRange(_ta.value.length,_ta.value.length);}catch(_e2){}}}
        break;
      }
    });

    // Status toggle buttons
    container.querySelectorAll('.status-toggle-btn').forEach(b=>b.addEventListener('click',async e=>{
      e.stopPropagation();
      var current = b.dataset.status;
      var next = cycleStatus(current);
      var card = b.closest('.client-card-item');
      // Find matching client by name+phone from card content
      var nameEl = card.querySelector('.client-card-name');
      var phoneEl = card.querySelector('.client-phone');
      if (!nameEl || !phoneEl) return;
      var cName = nameEl.textContent;
      var cPhone = phoneEl.dataset.full;
      var a = JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      var idx = a.findIndex(c=>c.name===cName&&c.phone===cPhone);
      if (idx < 0) return;
      a[idx].status = next;
      localStorage.setItem(CLIENTS_K, JSON.stringify(a));
      await syncOp('updateClient', { matchName: cName, matchPhone: cPhone, matchTime: a[idx].time||'', client: a[idx] });
      renderClientList();
    }));

    /* Flag dot toggle for client list cards */
    container.querySelectorAll('.flag-dot').forEach(function(b) {
      b.addEventListener('click', async function(e) {
        e.stopPropagation();
        var card = b.closest('.client-card-item');
        var nameEl = card.querySelector('.client-card-name');
        var phoneEl = card.querySelector('.client-phone');
        if (!nameEl || !phoneEl) return;
        var cName = nameEl.textContent;
        var cPhone = phoneEl.dataset.full;
        var a = JSON.parse(localStorage.getItem(CLIENTS_K) || '[]');
        var idx = a.findIndex(function(c) { return c.name === cName && c.phone === cPhone; });
        if (idx < 0) return;
        a[idx].flagged = !a[idx].flagged;
        localStorage.setItem(CLIENTS_K, JSON.stringify(a));
        await syncOp('updateClient', { matchName: cName, matchPhone: cPhone, matchTime: a[idx].time || '', client: a[idx] });
        renderClientList();
      });
    });

    /* Inline followup add for client list cards */
    container.querySelectorAll('.cl-add-followup-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var card = btn.closest('.client-card-item');
        var form = card.querySelector('.cl-followup-inline-form');
        var input = card.querySelector('.cl-followup-inline-input');
        if (form.style.display === 'none' || !form.style.display) {
          form.style.display = 'block'; input.value = ''; input.focus();
        } else {
          form.style.display = 'none';
        }
      });
    });
    container.querySelectorAll('.cl-followup-save-btn').forEach(function(btn) {
      btn.addEventListener('click', async function(e) {
        e.stopPropagation();
        var card = btn.closest('.client-card-item');
        var input = card.querySelector('.cl-followup-inline-input');
        var content = input.value.trim();
        if (!content) { alert('请输入跟进内容'); return; }
        var nameEl = card.querySelector('.client-card-name');
        var phoneEl = card.querySelector('.client-phone');
        if (!nameEl || !phoneEl) return;
        var cName = nameEl.textContent;
        var cPhone = phoneEl.dataset.full;
        var a = JSON.parse(localStorage.getItem(CLIENTS_K) || '[]');
        var matchIdx = a.findIndex(function(c) {
          return c.name === cName && c.phone === cPhone;
        });
        if (matchIdx < 0) return;
        if (!a[matchIdx].followUps) a[matchIdx].followUps = [];
        a[matchIdx].followUps.push({ date: getTodayStr(), time: getCurrentTime(), content: content });
        localStorage.setItem(CLIENTS_K, JSON.stringify(a));
        await syncOp('updateClient', { matchName: cName, matchPhone: cPhone, matchTime: a[matchIdx].time || '', client: a[matchIdx] });
        renderClientList();
        refreshAll();
      });
    });
    container.querySelectorAll('.cl-followup-cancel-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var card = btn.closest('.client-card-item');
        var form = card.querySelector('.cl-followup-inline-form');
        form.style.display = 'none';
      });
    });

    container.querySelectorAll('.del-icon').forEach(b=>b.addEventListener('click',async e=>{
      const name=b.dataset.name;
      const phone=b.dataset.phone;
      const time=b.dataset.time;
      const a=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      const idx=a.findIndex(c=>c.name===name&&c.phone===phone&&c.time===time);
      if(idx<0)return;
      a.splice(idx,1);localStorage.setItem(CLIENTS_K,JSON.stringify(a));
      renderClientList();refreshAll();
      await syncOp('removeClientByMatch',{name:name,phone:phone,time:time});
    }));
    container.querySelectorAll('.edit-icon').forEach(b=>b.addEventListener('click',async e=>{
      const name=b.dataset.name;
      const phone=b.dataset.phone;
      const time=b.dataset.time;
      const a=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      const idx=a.findIndex(c=>c.name===name&&c.phone===phone&&c.time===time);
      if(idx<0)return;
      const c=a[idx];
      // Set editing marker — addClient() will replace this entry instead of appending
      window._editingClientKey = name + '|' + phone + '|' + (time||'');
      document.getElementById('custName').value=c.name;
      document.getElementById('custPhone').value=c.phone;
      document.getElementById('custCompany').value=c.company||'';
      document.getElementById('custFund').value=c.fund||'';
      document.getElementById('custNote').value=c.note||'';
      var fuVal = '';
      if (c.followUps && c.followUps.length > 0) { fuVal = c.followUps.map(function(f){ return '[' + (f.date||'') + ' ' + (f.time||'') + '] ' + (f.content||''); }).join('\\n'); }
      else if (c.followUp) { fuVal = c.followUp; }
      document.getElementById('custFollowUp').value = fuVal;
      // Pre-fill new detail fields
      var dAge=document.getElementById('custAge'); if(dAge)dAge.value=c.age||'';
      var dMs=document.getElementById('custMaritalStatus'); if(dMs)dMs.value=c.maritalStatus||'';
      var dSh=document.getElementById('custIsShenzhenHukou'); if(dSh)dSh.value=c.isShenzhenHukou||'';
      var dSs=document.getElementById('custSocialSecurity'); if(dSs)dSs.value=c.socialSecurity||'';
      var dAs=document.getElementById('custAvgSalary'); if(dAs)dAs.value=c.avgSalary||'';
      var dTx=document.getElementById('custTax2yr'); if(dTx)dTx.value=c.tax2yr||'';
      var dSb=document.getElementById('custSalaryBank'); if(dSb)dSb.value=c.salaryBank||'';
      var dEd=document.getElementById('custEducation'); if(dEd)dEd.value=c.education||'';
      var dPr=document.getElementById('custProperty'); if(dPr)dPr.value=c.property||'';
      var dPt=document.getElementById('custPropertyType'); if(dPt)dPt.value=c.propertyType||'';
      var dPa=document.getElementById('custPropertyAddress'); if(dPa)dPa.value=c.propertyAddress||'';
      var dPAr=document.getElementById('custPropertyArea'); if(dPAr)dPAr.value=c.propertyArea||'';
      var dPmb=document.getElementById('custPropertyMortgageBank'); if(dPmb)dPmb.value=c.propertyMortgageBank||'';
      var dPma=document.getElementById('custPropertyMortgageAmount'); if(dPma)dPma.value=c.propertyMortgageAmount||'';
      var dPo=document.getElementById('custPropertyOther'); if(dPo)dPo.value=c.propertyOther||'';
      var dBd=document.getElementById('custBankDebt'); if(dBd)dBd.value=c.bankDebt||'';
      var dCd=document.getElementById('custCreditCardDebt'); if(dCd)dCd.value=c.creditCardDebt||'';
      var dQ3=document.getElementById('custQuery3m'); if(dQ3)dQ3.value=c.query3m||'';
      var dOl=document.getElementById('custOnlineLoanCount'); if(dOl)dOl.value=c.onlineLoanCount||'';
      var dDm=document.getElementById('custDemand'); if(dDm)dDm.value=c.demand||'';
      var dFu=document.getElementById('custFundUsage'); if(dFu)dFu.value=c.fundUsage||'';
      var dVt=document.getElementById('custVisitTime'); if(dVt)dVt.value=c.visitTime||'';
      var dSt=document.getElementById('custStatus'); if(dSt)dSt.value=c.status||'';
      var dLb=document.getElementById('custLabel'); if(dLb)dLb.value=c.label||'';
      var dAb=document.getElementById('custApprovedBank'); if(dAb)dAb.value=c.approvedBank||'';
      var dAa=document.getElementById('custApprovedAmount'); if(dAa)dAa.value=c.approvedAmount||'';
      var dRt=document.getElementById('custRateTerm'); if(dRt)dRt.value=c.rateTerm||'';
      var dRb=document.getElementById('custRejectedBank'); if(dRb)dRb.value=c.rejectedBank||'';
      var dRr=document.getElementById('custRejectReason'); if(dRr)dRr.value=c.rejectReason||'';
      showStatusConditionalFields(c.status||'');
      var kqEl=document.getElementById('keyQuestionsIntent'); if(kqEl)kqEl.innerHTML=renderKeyQuestionsHTML('kq_',c.keyQuestions||[]);
      // Auto-expand detail panel if any new field has a value
      var hasDetail = c.age||c.maritalStatus||c.isShenzhenHukou||c.socialSecurity||c.avgSalary||c.tax2yr||c.salaryBank||c.education||c.property||c.propertyType||c.propertyAddress||c.propertyArea||c.propertyMortgageBank||c.propertyMortgageAmount||c.propertyOther||c.bankDebt||c.creditCardDebt||c.query3m||c.onlineLoanCount||c.demand||c.fundUsage||c.visitTime||c.note||(c.followUps&&c.followUps.length>0)||c.followUp||(c.keyQuestions&&c.keyQuestions.length>0);
      var panel = document.getElementById('detailPanel');
      var toggleBtn = document.getElementById('detailToggleBtn');
      if (hasDetail && panel && panel.style.display === 'none') {
        panel.style.display = 'flex';
        var icon = toggleBtn.querySelector('.detail-toggle-icon');
        if (icon) icon.classList.add('open');
        toggleBtn.innerHTML = '<span class="detail-toggle-icon open">▶</span> 收起详细资料';
      }
      // Do NOT delete from list yet — keep data safe until "添加" saves the update
      // Mark the add button to show "保存修改" state
      var addBtn = document.getElementById('addClientBtn');
      if (addBtn) { addBtn.textContent = '保存修改'; addBtn.style.background = 'var(--accent-btn)'; }
      document.getElementById('custName').focus();
    }));
    container.querySelectorAll('.export-single-btn').forEach(b=>b.addEventListener('click',async e=>{
      const name=b.dataset.name;
      const phone=b.dataset.phone;
      const time=b.dataset.time;
      const a=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      const c=a.find(item=>item.name===name&&item.phone===phone&&(time?item.time===time:true));
      if(!c)return;
      const savedUrl=(localStorage.getItem('webhook_url')||'').trim();
      if(!savedUrl){
      }
      b.textContent='...';
      b.disabled=true;
      try{
        const r=await fetch('/api/export',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({type:'single_client',webhookUrl:savedUrl,client:c})
        });
        if(r.ok){
          const err=await r.json();
          alert('导出失败: ' + (err.error || r.statusText));
        }
      }catch(errVal){
        alert('网络错误: ' + errVal.message);
      }
      b.textContent='出';
      b.disabled=false;
    }));
    container.querySelectorAll('.phone-toggle').forEach(b=>b.addEventListener('click',e=>{
      e.stopPropagation();
      const phoneSpan=b.previousElementSibling;
      const full=phoneSpan.dataset.full;
      if(phoneSpan.textContent===full){
        phoneSpan.textContent=maskPhone(full);
        b.title='显示号码';
        b.textContent='看';
      }else{
        phoneSpan.textContent=full;
        b.title='隐藏号码';
        b.textContent='隐';
      }
    }));
  }

  var todoActiveTab = 'today'; // 'today' or 'tomorrow'
  function renderTodos(){
    const today=getTodayStr();
    const isToday = todoActiveTab === 'today';
    const storageKey = isToday ? TODAY_TODO_K : TOMORROW_TODO_K;
    const list = isToday ? 'today' : 'tomorrow';
    const todos = loadTodos(storageKey).filter(t=> (typeof t==='string'?today:(t.date||today))===today);
    const container = document.getElementById('todoList');
    if (!container) return;
    const makeItem=(t,i)=>{
      const txt=typeof t==='string'?t:t.text;
      const rm=t&&t.remind?'<span class="todo-time-tag">'+esc(t.remind)+'</span>':'';
      return '<div class="todo-item-clean"><span class="todo-number-clean">'+(i+1)+'.</span><span class="todo-text-clean">'+esc(txt)+rm+'</span><button class="todo-del-btn-clean" data-idx="'+i+'" data-list="'+list+'">✕</button></div>';
    };
    container.innerHTML=todos.length===0?'<div style="font-size:0.75rem;color:var(--text-light);padding:6px;">暂无待办</div>':todos.map((t,i)=>makeItem(t,i)).join('');
    container.querySelectorAll('.todo-del-btn-clean').forEach(b=>b.addEventListener('click',async e=>{
      const i=parseInt(b.dataset.idx),l=b.dataset.list;
      const storageKey2 = l==='today'?TODAY_TODO_K:TOMORROW_TODO_K;
      const todos2=loadTodos(storageKey2);
      todos2.splice(i,1);saveTodos(storageKey2,todos2);renderTodos();
      await syncOp(l==='today'?'setTodayTodos':'setTomorrowTodos',{todos:todos2});
    }));
    // Update tab button styles
    document.querySelectorAll('.todo-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === todoActiveTab);
    });
  }

  function renderCalendar(wm,im){
    const [y,m]=calendarMonth.split('-').map(Number);const ref=new Date(y,m-1);
    const fd=new Date(y,m-1,1);let si=(fd.getDay()+6)%7;
    const dim=new Date(y,m,0).getDate(),ts=getTodayStr();
    const clients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const ccMap={};clients.forEach(c=>{if(c.date)ccMap[c.date]=(ccMap[c.date]||0)+1;});
    const tempClients=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
    const tcMap={};tempClients.forEach(c=>{if(c.date)tcMap[c.date]=(tcMap[c.date]||0)+1;});
    const tcm=loadMap(TEMP_CLIENTS_MAP_K);
    for(const [ds,c] of Object.entries(tcm)){tcMap[ds]=Math.max(tcMap[ds]||0,c);}
    const mn=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    document.getElementById('calMonthTitle').innerHTML=y+'年 '+mn[m-1];
    let g='';const wd=['一','二','三','四','五','六','日'];
    wd.forEach(d=>{g+='<div class="cal-weekday">'+d+'</div>';});
    for(let i=0;i<si;i++)g+='<div class="cal-day"></div>';
    for(let d=1;d<=dim;d++){
      const ds=y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      const wv=wm[ds]||0,iv=im[ds]||0,cv=ccMap[ds]||0,tv=tcMap[ds]||0;
      let bh='';if(wv>0||iv>0||cv>0||tv>0)bh='<div class="day-badge">'+(wv>0?'<span>微'+wv+'</span>':'')+(iv>0?'<span>意'+iv+'</span>':'')+(cv>0?'<span>客'+cv+'</span>':'')+(tv>0?'<span>临'+tv+'</span>':'')+'</div>';
      const it=ds===ts, pt=ds<ts;
      g+='<div class="cal-day'+(it?' today':pt?' past':'')+'" data-date="'+ds+'" data-w="'+wv+'" data-i="'+iv+'" data-t="'+tv+'"><div class="day-number">'+d+'</div>'+bh+'</div>';
    }
    document.getElementById('calGrid').innerHTML=g;
    const tip=document.getElementById('globalTooltip');
    document.querySelectorAll('.cal-day[data-date]').forEach(c=>{
      c.addEventListener('mouseenter',e=>{tip.innerHTML='<strong>'+c.dataset.date+'</strong> 微'+(c.dataset.w||0)+' 意'+(c.dataset.i||0)+' 临'+(c.dataset.t||0);tip.classList.add('show');});
      c.addEventListener('mouseleave',()=>tip.classList.remove('show'));
      c.addEventListener('mousemove',e=>{tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY-28)+'px';});
      c.addEventListener('click',e=>{e.stopPropagation();if(c.dataset.date)showTimelineForDate(c.dataset.date);});
    });
  }

  async function showTimelineForDate(ds){
    document.getElementById('modalDateTitle').innerText=ds+' 时间线';
    document.getElementById('modalClientList').innerHTML='<div class="empty-clients">加载中...</div>';
    document.getElementById('dateModal').classList.add('active');
    let clients=[], todos=[], cloudData=null;
    try{
      const r=await fetch('/api/data?date='+ds);
      if(r.ok){
        cloudData=await r.json();
        if(cloudData.clients&&cloudData.clients.length>0)clients=cloudData.clients;
        if(cloudData.todayTodos&&cloudData.todayTodos.length>0)todos=cloudData.todayTodos;
      }
    }catch(e){}
    // 合并本地客户到云端列表（本地最新优先）
    const localAll=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const localDay=localAll.filter(c=>c.date===ds);
    localDay.forEach(lc=>{
      const exist=clients.findIndex(cc=>cc.name===lc.name&&cc.phone===lc.phone&&cc.time===lc.time);
      if(exist>=0){clients[exist]=lc;}else{clients.push(lc);}
    });
    if(todos.length===0&&ds===getTodayStr())todos=loadTodos(TODAY_TODO_K);
    // 合并临时登记客户
    let tempClients=[];
    if(cloudData&&cloudData.tempClients&&cloudData.tempClients.length>0){
      tempClients=cloudData.tempClients.filter(function(tc){return tc.date===ds;});
    }
    const localTempAll=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
    const localTempDay=localTempAll.filter(c=>c.date===ds);
    localTempDay.forEach(ltc=>{
      const exist=tempClients.findIndex(tc=>tc.name===ltc.name&&tc.phone===ltc.phone&&tc.time===ltc.time);
      if(exist>=0){tempClients[exist]=ltc;}else{tempClients.push(ltc);}
    });
    // 同时获取该日期的 todoLog（永久待办记录）
    let todoLog=[];
    if(cloudData&&cloudData.todoLog)todoLog=cloudData.todoLog;
    let timeline=[];
    clients.forEach((c,i)=>{timeline.push({type:'client',time:c.time||'',name:c.name,phone:c.phone,company:c.company||'',fund:c.fund||'',label:c.label||'',note:c.note,idx:i,
      age:c.age,maritalStatus:c.maritalStatus,isShenzhenHukou:c.isShenzhenHukou,
      socialSecurity:c.socialSecurity,avgSalary:c.avgSalary,tax2yr:c.tax2yr,
      salaryBank:c.salaryBank,education:c.education,property:c.property,
      propertyType:c.propertyType,propertyAddress:c.propertyAddress,propertyArea:c.propertyArea,
      propertyMortgageBank:c.propertyMortgageBank,propertyMortgageAmount:c.propertyMortgageAmount,propertyOther:c.propertyOther,
      bankDebt:c.bankDebt,creditCardDebt:c.creditCardDebt,query3m:c.query3m,
      onlineLoanCount:c.onlineLoanCount,demand:c.demand,fundUsage:c.fundUsage,status:c.status,
      followUps:c.followUps||[],
      visitTime:c.visitTime||'',approvedBank:c.approvedBank||'',approvedAmount:c.approvedAmount||'',
      rateTerm:c.rateTerm||'',rejectedBank:c.rejectedBank||'',rejectReason:c.rejectReason||''});});
    tempClients.forEach((c,i)=>{timeline.push({type:'tempClient',time:c.time||'',name:c.name,phone:c.phone,note:c.note,idx:i});});
    todos.forEach(t=>{const txt=typeof t==='string'?t:t.text;const tm=t&&t.time?t.time:'';if(txt)timeline.push({type:'todo',time:tm,text:txt});});
    todoLog.forEach(t=>{const txt=typeof t==='string'?t:t.text;const tm=t&&t.time?t.time:'';const tp=t.type==='tomorrow'?' (明日)':'';if(txt)timeline.push({type:'todo',time:tm,text:txt+tp});});
    timeline.sort((a,b)=>(a.time||'').localeCompare(b.time||''));
    function renderTl(){
      const clients_in_tl = timeline.filter(e=>e.type==='client');
      const temp_in_tl    = timeline.filter(e=>e.type==='tempClient');
      const todos_in_tl   = timeline.filter(e=>e.type==='todo');

      if(timeline.length===0){
        document.getElementById('modalClientList').innerHTML='<div class="empty-clients">— 当日无记录 —</div>';
        return;
      }

      let html = '';

      // ===== 意向客户区 =====
      if(clients_in_tl.length>0){
        html += '<div>';
        html += '<div class="modal-section-title">意向客户<span style="font-size:0.7rem;color:var(--accent-intent);margin-left:4px;font-weight:800;">'+clients_in_tl.length+'人</span></div>';
        html += '<div style="display:flex;flex-direction:column;gap:10px;">';
        clients_in_tl.forEach((e,i)=>{
          html += '<div class="client-card-item' + (e.status ? ' ' + STATUS_CLASSES[e.status] : '') + '">'+
            '<div class="client-card-top">'+
              '<div class="client-card-primary">'+
                '<span class="client-card-name">'+esc(e.name)+'</span>'+
                '<span class="client-card-phone-wrap">'+
                  '<a class="modal-client-phone" href="tel:'+esc(e.phone)+'" data-full="'+esc(e.phone)+'">'+esc(maskPhone(e.phone))+'</a>'+
                  '<button class="phone-toggle" title="显示号码">看</button>'+
                '</span>'+
              '</div>'+
              (e.time ? '<span class="client-card-time">'+esc(e.time)+'</span>' : '')+
            '</div>'+
            getStatusBadgeHtml(e) +
            '<div class="client-card-tags">'+
              (e.label ? '<span class="client-card-tag client-card-tag-grade-' + esc(e.label).toLowerCase() + '">' + esc(e.label) + '类客户</span>' : '')+
              (e.company ? getWhitelistTagHtml(e.company, false) : '')+
              (e.fund ? '<span class="client-card-tag client-card-tag-fund">公积金: '+esc(e.fund)+'</span>' : '')+
              getClientDetailTags(e) +
              (e.visitTime ? '<span class="client-card-tag client-card-tag-detail">上门:'+esc(e.visitTime)+'</span>' : '')+
            '</div>'+
            '<div class="client-card-body">'+
              '<div class="client-card-content-block">'+
                '<span class="client-card-label">沟通记录</span>'+
                '<div id="cn_'+e.idx+'">'+
                  '<div class="tbl-note-text" style="cursor:pointer;">'+(e.note?esc(e.note):'<span class="tbl-note-empty">点击添加沟通记录…</span>')+'</div>'+
                '</div>'+
              '</div>'+
              '<div class="client-card-content-block follow-up">'+
                '<div style="display:flex;justify-content:space-between;align-items:center;">'+
                  '<span class="client-card-label">跟进记录('+(e.followUps?e.followUps.length:0)+')</span>'+
                  '<button class="tl-add-followup-btn" data-idx="'+e.idx+'" title="新增跟进记录" style="font-size:0.9rem;width:24px;height:24px;border:none;background:transparent;color:var(--accent-wechat);cursor:pointer;font-weight:700;line-height:1;display:flex;align-items:center;justify-content:center;">+</button>'+
                '</div>'+
                (e.followUps && e.followUps.length > 0 ?
                  '<div class="follow-up-list">'+
                    e.followUps.map(function(fu){ return '<div class="follow-up-record"><div class="follow-up-record-header">'+esc(fu.date||'')+' '+esc(fu.time||'')+'</div><div class="follow-up-record-text">'+esc(fu.content||'')+'</div></div>'; }).join('')+
                  '</div>' : (e.followUp ?
                  '<span class="client-card-text">'+esc(e.followUp)+'</span>' : ''))+
                '<div class="tl-followup-inline-form" style="display:none;margin-top:6px;">'+
                  '<textarea class="tl-followup-inline-input" placeholder="新增跟进记录..." style="width:100%;min-height:44px;padding:6px 8px;font-size:0.78rem;resize:vertical;border:1px solid var(--card-border);border-radius:6px;background:var(--input-bg);color:var(--text-main);font-family:inherit;box-sizing:border-box;"></textarea>'+
                  '<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:4px;">'+
                    '<button class="tl-followup-save-btn" data-idx="'+e.idx+'" style="font-size:0.7rem;padding:3px 10px;background:var(--accent-btn);color:#fff;border:none;border-radius:4px;font-weight:700;cursor:pointer;">保存</button>'+
                    '<button class="tl-followup-cancel-btn" style="font-size:0.7rem;padding:3px 10px;background:var(--btn-bg);color:var(--text-soft);border:1px solid var(--card-border);border-radius:4px;font-weight:700;cursor:pointer;">取消</button>'+
                  '</div>'+
                '</div>'+
              '</div>'+
              (e.demand ?
                '<div class="client-card-content-block">'+
                  '<span class="client-card-label">客户需求</span>'+
                  '<span class="client-card-text">'+esc(e.demand)+'</span>'+
                '</div>' : '')+
              (e.fundUsage ?
                '<div class="client-card-content-block">'+
                  '<span class="client-card-label">资金用途</span>'+
                  '<span class="client-card-text">'+esc(e.fundUsage)+'</span>'+
                '</div>' : '')+
              (e.status==='success' ?
                '<div class="client-card-content-block" style="border-left-color:#27ae60;">'+
                  '<span class="client-card-label">办理成功</span>'+
                  '<span class="client-card-text">批款银行: '+esc(e.approvedBank||'')+' | 金额: '+esc(e.approvedAmount||'')+' | 利率年限: '+esc(e.rateTerm||'')+'</span>'+
                '</div>' : '')+
              (e.status==='failed' ?
                '<div class="client-card-content-block" style="border-left-color:#e67e22;">'+
                  '<span class="client-card-label">办理未成功</span>'+
                  '<span class="client-card-text">拒绝银行: '+esc(e.rejectedBank||'')+' | 原因: '+esc(e.rejectReason||'')+'</span>'+
                '</div>' : '')+
            '</div>'+
            '<div class="client-card-actions">'+
              getStatusToggleHtml(e) +
              '<button class="export-timeline-single-btn" data-idx="'+e.idx+'" title="导出"><svg width="15" height="15" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l7.5-7.5M5.5 5H12v6.5"/></svg></button>'+
              '<button class="edit-note-btn" title="编辑客户信息" data-idx="'+e.idx+'"><svg width="15" height="15" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 3l2 2L6 13.5H3.5v-2.5L11.5 3z"/></svg></button>'+
              '<button class="delete-timeline-client-btn" title="删除客户" data-idx="'+e.idx+'">删</button>'+
            '</div>'+
          '</div>';
        });
        html += '</div></div>';
      }

      // ===== 临时登记区 =====
      if(temp_in_tl.length>0){
        html += '<div style="margin-top:'+(clients_in_tl.length>0?'12px':'0')+'">';
        html += '<div class="modal-section-title">临时登记 <span style="font-size:0.7rem;color:var(--accent-wechat);margin-left:4px;font-weight:800;">'+temp_in_tl.length+'人</span></div>';
        html += '<div style="display:flex;flex-direction:column;gap:8px;">';
        temp_in_tl.forEach(e=>{
          html += '<div class="client-card-item" style="border-left: 3px solid var(--accent-wechat);">'+
            '<div class="client-card-top">'+
              '<span class="client-card-name">'+esc(e.name)+'</span>'+
              '<span class="client-card-time">'+esc(e.time||'')+'</span>'+
            '</div>'+
            '<div class="client-card-tags">'+
              '<span class="client-card-tag" style="background:rgba(255,255,255,0.4);color:var(--accent-wechat);">电话: '+esc(e.phone)+'</span>'+
              (e.company ? '<span class="client-card-tag" style="background:rgba(255,255,255,0.4);">单位: '+esc(e.company)+'</span>' : '')+
              (e.fund ? '<span class="client-card-tag" style="background:rgba(255,255,255,0.4);">公积金: '+esc(e.fund)+'</span>' : '')+
            '</div>'+
            (e.note ? '<div class="client-card-body"><div class="client-card-content-block"><span class="client-card-label">回访备注</span><span class="client-card-text">'+esc(e.note)+'</span></div></div>' : '')+
          '</div>';
        });
        html += '</div></div>';
      }

      // ===== 待办事项区 =====
      if(todos_in_tl.length>0){
        html += '<div style="margin-top:'+(clients_in_tl.length>0||temp_in_tl.length>0?'4px':'0')+'">';
        html += '<div class="modal-section-title">待办事项 <span style="font-size:0.7rem;color:var(--accent-wechat);margin-left:4px;font-weight:800;">'+todos_in_tl.length+'条</span></div>';
        html += '<div style="display:flex;flex-direction:column;gap:6px;">';
        todos_in_tl.forEach(e=>{
          html += '<div class="todo-card-item"><div style="flex:1;"><div class="todo-card-text">'+esc(e.text)+'</div>'+(e.time?'<div class="todo-card-time">'+esc(e.time)+'</div>':'')+'</div></div>';
        });
        html += '</div></div>';
      }

      document.getElementById('modalClientList').innerHTML = html;

      bindEditBtns();
      bindDeleteBtns();
      bindFollowupBtns();
      // Bind Status toggle for timeline cards
      document.querySelectorAll('#modalClientList .status-toggle-btn').forEach(b=>b.addEventListener('click',async e=>{
        e.stopPropagation();
        var current = b.dataset.status;
        var next = cycleStatus(current);
        var card = b.closest('.client-card-item');
        var nameEl = card.querySelector('.client-card-name');
        var phoneEl = card.querySelector('.modal-client-phone');
        if (!nameEl || !phoneEl) return;
        var cName = nameEl.textContent;
        var cPhone = phoneEl.dataset.full;
        var a = JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
        var idx = a.findIndex(c=>c.name===cName&&c.phone===cPhone);
        if (idx < 0) return;
        a[idx].status = next;
        localStorage.setItem(CLIENTS_K, JSON.stringify(a));
        await syncOp('updateClient', { matchName: cName, matchPhone: cPhone, matchTime: a[idx].time||'', client: a[idx] }, ds);
        showTimelineForDate(ds);
      }));
      /* Flag dot toggle for timeline cards */
      document.querySelectorAll('#modalClientList .flag-dot').forEach(function(b) {
        b.addEventListener('click', async function(e) {
          e.stopPropagation();
          var card = b.closest('.client-card-item');
          var nameEl = card.querySelector('.client-card-name');
          var phoneEl = card.querySelector('.modal-client-phone');
          if (!nameEl || !phoneEl) return;
          var cName = nameEl.textContent;
          var cPhone = phoneEl.dataset.full;
          var a = JSON.parse(localStorage.getItem(CLIENTS_K) || '[]');
          var idx = a.findIndex(function(c) { return c.name === cName && c.phone === cPhone; });
          if (idx < 0) return;
          a[idx].flagged = !a[idx].flagged;
          localStorage.setItem(CLIENTS_K, JSON.stringify(a));
          await syncOp('updateClient', { matchName: cName, matchPhone: cPhone, matchTime: a[idx].time || '', client: a[idx] }, ds);
          showTimelineForDate(ds);
        });
      });
      // Bind Timeline Single Client Export
      document.querySelectorAll('.export-timeline-single-btn').forEach(btn=>{
        btn.onclick=async function(){
          const idx=parseInt(this.dataset.idx);
          const ti=timeline.find(t=>t.type==='client'&&t.idx===idx);
          if(!ti)return;
          const savedUrl=(localStorage.getItem('webhook_url')||'').trim();
          if(!savedUrl){
          }
          btn.textContent='...';
          btn.disabled=true;
          try{
            const r=await fetch('/api/export',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({
                type:'single_client',
                webhookUrl:savedUrl,
                client:{
                  date:ds,
                  name:ti.name,
                  phone:ti.phone,
                  company:ti.company,
                  fund:ti.fund,
                  note:ti.note,
                  time:ti.time,
                  age:ti.age,
                  maritalStatus:ti.maritalStatus,
                  isShenzhenHukou:ti.isShenzhenHukou,
                  socialSecurity:ti.socialSecurity,
                  avgSalary:ti.avgSalary,
                  tax2yr:ti.tax2yr,
                  salaryBank:ti.salaryBank,
                  education:ti.education,
                  property:ti.property,
                  propertyType:ti.propertyType,propertyAddress:ti.propertyAddress,propertyArea:ti.propertyArea,
                  propertyMortgageBank:ti.propertyMortgageBank,propertyMortgageAmount:ti.propertyMortgageAmount,propertyOther:ti.propertyOther,
                  bankDebt:ti.bankDebt,
                  creditCardDebt:ti.creditCardDebt,
                  query3m:ti.query3m,
                  onlineLoanCount:ti.onlineLoanCount,
                  demand:ti.demand,
                  fundUsage:ti.fundUsage,
                  keyQuestions:ti.keyQuestions,
                  followUps:ti.followUps,
                  status:ti.status
                }
              })
            });
            if(r.ok){
              alert('导出失败: ' + (err.error || r.statusText));
            }
          }catch(errVal){
            alert('网络错误: ' + errVal.message);
          }
          btn.textContent='出';
          btn.disabled=false;
        };
      });
      document.querySelectorAll('#modalClientList .phone-toggle').forEach(b=>b.addEventListener('click',e=>{
        e.stopPropagation();
        const phoneSpan=b.previousElementSibling;
        const full=phoneSpan.dataset.full;
        if(phoneSpan.textContent===full){
          phoneSpan.textContent=maskPhone(full);
          b.title='显示号码';
          b.textContent='看';
        }else{
          phoneSpan.textContent=full;
          b.title='隐藏号码';
          b.textContent='隐';
        }
      }));
    }
    function bindEditBtns(){
      document.querySelectorAll('.edit-note-btn').forEach(btn=>{
        btn.onclick=function(){
          const idx=parseInt(this.dataset.idx);
          const ti=timeline.find(t=>t.type==='client'&&t.idx===idx);
          if(!ti)return;
          // 从完整clients数组获取所有字段（反向遍历优先取本地版本，避免云端旧数据缺少status等新字段）
          let fullClient = ti;
          for (let i = clients.length - 1; i >= 0; i--) {
            if (clients[i].name === ti.name && clients[i].phone === ti.phone) {
              fullClient = clients[i];
              break;
            }
          }
          const card = btn.closest('.client-card-item');
          if(!card) return;
          card.classList.add('all-client-card-editing');
          card.innerHTML =
            '<div class="client-card-top">' +
              '<span style="font-size:0.75rem;font-weight:700;color:var(--accent-wechat);">编辑客户信息</span>' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple edit-name-input" placeholder="姓名" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.8rem;font-weight:700;" value="' + esc(fullClient.name||ti.name) + '">' +
              '<input type="text" class="input-simple edit-phone-input" placeholder="电话" readonly autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.8rem;background:var(--input-disabled-bg, #e9ecef);color:var(--text-soft);cursor:not-allowed;" value="' + esc(fullClient.phone||ti.phone) + '">' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple edit-company-input" placeholder="单位" autocomplete="off" style="flex:2;min-width:120px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.company||'') + '">' +
              '<input type="text" class="input-simple edit-fund-input" placeholder="公积金基数" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.fund||'') + '">' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<select class="input-simple input-select edit-label-input" required style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;height:auto;border:1.5px solid var(--card-border);"><option value="">客户等级 *</option><option value="A"' + (fullClient.label==='A'?' selected':'') + '>A 类 — 重点跟进</option><option value="B"' + (fullClient.label==='B'?' selected':'') + '>B 类 — 常规跟进</option><option value="C"' + (fullClient.label==='C'?' selected':'') + '>C 类 — 低优先级</option></select>' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple edit-age-input" placeholder="年龄" autocomplete="off" style="flex:1;min-width:60px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.age||'') + '">' +
              '<select class="input-simple input-select edit-marital-input" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">婚姻状况</option><option value="未婚"' + (fullClient.maritalStatus==='未婚'?' selected':'') + '>未婚</option><option value="已婚"' + (fullClient.maritalStatus==='已婚'?' selected':'') + '>已婚</option><option value="离异"' + (fullClient.maritalStatus==='离异'?' selected':'') + '>离异</option><option value="丧偶"' + (fullClient.maritalStatus==='丧偶'?' selected':'') + '>丧偶</option></select>' +
              '<select class="input-simple input-select edit-hukou-input" style="flex:1;min-width:70px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">是否深户</option><option value="是"' + (fullClient.isShenzhenHukou==='是'?' selected':'') + '>是</option><option value="否"' + (fullClient.isShenzhenHukou==='否'?' selected':'') + '>否</option></select>' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple edit-ss-input" placeholder="社保养老基数" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.socialSecurity||'') + '">' +
              '<input type="text" class="input-simple edit-salary-input" placeholder="月均工资" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.avgSalary||'') + '">' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple edit-tax-input" placeholder="近2年个税" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.tax2yr||'') + '">' +
              '<input type="text" class="input-simple edit-sbank-input" placeholder="代发工资银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.salaryBank||'') + '">' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<select class="input-simple input-select edit-edu-input" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">学历</option><option value="初中及以下"' + (fullClient.education==='初中及以下'?' selected':'') + '>初中及以下</option><option value="高中"' + (fullClient.education==='高中'?' selected':'') + '>高中</option><option value="大专"' + (fullClient.education==='大专'?' selected':'') + '>大专</option><option value="本科"' + (fullClient.education==='本科'?' selected':'') + '>本科</option><option value="硕士"' + (fullClient.education==='硕士'?' selected':'') + '>硕士</option><option value="博士"' + (fullClient.education==='博士'?' selected':'') + '>博士</option></select>' +
              '<select class="input-simple input-select edit-prop-input" style="flex:1;min-width:70px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">房产</option><option value="无房"' + (fullClient.property==='无房'?' selected':'') + '>无房</option><option value="有一套"' + (fullClient.property==='有一套'?' selected':'') + '>有一套</option><option value="有多套"' + (fullClient.property==='有多套'?' selected':'') + '>有多套</option></select>' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<select class="input-simple input-select edit-proptype-input" style="flex:1;min-width:90px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">深房/外地房</option><option value="深房"' + (fullClient.propertyType==='深房'?' selected':'') + '>深房</option><option value="外地房"' + (fullClient.propertyType==='外地房'?' selected':'') + '>外地房</option></select>' +
              '<input type="text" class="input-simple edit-proparea-input" placeholder="面积" autocomplete="off" style="flex:1;min-width:70px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.propertyArea||'') + '">' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple edit-propaddr-input" placeholder="房产地址" autocomplete="off" style="flex:1;min-width:120px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.propertyAddress||'') + '">' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple edit-propmbank-input" placeholder="抵押银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.propertyMortgageBank||'') + '">' +
              '<input type="text" class="input-simple edit-propmamt-input" placeholder="还欠多少" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.propertyMortgageAmount||'') + '">' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple edit-propother-input" placeholder="房产其他情况" autocomplete="off" style="flex:1;min-width:120px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.propertyOther||'') + '">' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple edit-bankdebt-input" placeholder="银行信贷负债" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.bankDebt||'') + '">' +
              '<input type="text" class="input-simple edit-ccdebt-input" placeholder="信用卡负债" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.creditCardDebt||'') + '">' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple edit-query-input" placeholder="近3个月查询次数" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.query3m||'') + '">' +
              '<input type="text" class="input-simple edit-onlineloan-input" placeholder="小额网贷笔数" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.onlineLoanCount||'') + '">' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple edit-visittime-input" placeholder="上门办理时间" autocomplete="off" style="flex:1;min-width:120px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.visitTime||'') + '">' +
              '<select class="input-simple input-select edit-status-input" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">状态</option><option value="success"' + (fullClient.status==='success'?' selected':'') + '>已办理成功</option><option value="failed"' + (fullClient.status==='failed'?' selected':'') + '>未办理成功</option></select>' +
            '</div>' +
            '<div class="edit-success-fields" style="display:' + (fullClient.status==='success'?'flex':'none') + ';flex-direction:column;gap:8px;">' +
              '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
                '<input type="text" class="input-simple edit-approvedbank-input" placeholder="批款银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.approvedBank||'') + '">' +
                '<input type="text" class="input-simple edit-approvedamount-input" placeholder="批款金额" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.approvedAmount||'') + '">' +
              '</div>' +
              '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
                '<input type="text" class="input-simple edit-rateterm-input" placeholder="利率年限" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.rateTerm||'') + '">' +
                '<span style="flex:1;"></span>' +
              '</div>' +
            '</div>' +
            '<div class="edit-failed-fields" style="display:' + (fullClient.status==='failed'?'flex':'none') + ';flex-direction:column;gap:8px;">' +
              '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
                '<input type="text" class="input-simple edit-rejectedbank-input" placeholder="拒绝银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.rejectedBank||'') + '">' +
                '<input type="text" class="input-simple edit-rejectreason-input" placeholder="拒绝原因" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(fullClient.rejectReason||'') + '">' +
              '</div>' +
            '</div>' +
            '<textarea class="input-simple edit-demand-input" placeholder="客户大致需求" style="width:100%;min-height:50px;padding:8px;font-size:0.78rem;resize:vertical;box-sizing:border-box;">' + esc(fullClient.demand||'') + '</textarea>' +
            '<textarea class="input-simple edit-fusage-input" placeholder="资金用途和时间" style="width:100%;min-height:50px;padding:8px;font-size:0.78rem;resize:vertical;box-sizing:border-box;">' + esc(fullClient.fundUsage||'') + '</textarea>' +
            '<textarea class="input-simple edit-note-input" placeholder="沟通记录（必填）" style="width:100%;min-height:70px;padding:8px;font-size:0.78rem;resize:vertical;box-sizing:border-box;">' + esc(fullClient.note||ti.note||'') + '</textarea>' +
            '<textarea class="input-simple edit-follow-input" placeholder="跟进情况" style="width:100%;min-height:60px;padding:8px;font-size:0.78rem;resize:vertical;box-sizing:border-box;">' + (fullClient.followUps && fullClient.followUps.length > 0 ? fullClient.followUps.map(function(f){ return '[' + (f.date||'') + ' ' + (f.time||'') + '] ' + (f.content||''); }).join('\\n') : esc(fullClient.followUp||'')) + '</textarea>' +
            '<div style="display:flex;justify-content:flex-end;gap:8px;border-top:1px dashed var(--card-border);padding-top:8px;">' +
              '<button class="save-timeline-client-btn btn-add" style="font-size:0.75rem;padding:6px 16px;background:var(--accent-btn);color:white;border:none;border-radius:6px;font-weight:700;">保存</button>' +
              '<button class="cancel-timeline-client-btn btn-add" style="font-size:0.75rem;padding:6px 16px;background:var(--btn-bg);color:var(--text-soft);border:1px solid var(--card-border);border-radius:6px;font-weight:700;">取消</button>' +
            '</div>';

          // Bind status change for conditional fields
          card.querySelector('.edit-status-input').addEventListener('change', function() {
            var sf = card.querySelector('.edit-success-fields');
            var ff = card.querySelector('.edit-failed-fields');
            if (sf) sf.style.display = this.value === 'success' ? 'flex' : 'none';
            if (ff) ff.style.display = this.value === 'failed' ? 'flex' : 'none';
          });

          // Bind Save
          card.querySelector('.save-timeline-client-btn').onclick = async () => {
            const n = card.querySelector('.edit-name-input').value.trim();
            const p = card.querySelector('.edit-phone-input').value.trim();
            const comp = card.querySelector('.edit-company-input').value.trim();
            const fund = card.querySelector('.edit-fund-input').value.trim();
            const label = (card.querySelector('.edit-label-input')||{}).value||'';
            const nt = card.querySelector('.edit-note-input').value.trim();
            var fuRaw = card.querySelector('.edit-follow-input').value.trim();
            // 跟进记录：多行「[日期 时间] 内容」还原为多条记录（保留原日期时间），纯文本走旧 followUp 字段
            var fuSplitTl = splitFollowUpsText(fuRaw);
            var newFollowUpsTl = fuSplitTl.followUps;
            // Read new detail fields
            const age = (card.querySelector('.edit-age-input')||{}).value||''; const ageV = age.trim();
            const ms = (card.querySelector('.edit-marital-input')||{}).value||'';
            const sh = (card.querySelector('.edit-hukou-input')||{}).value||'';
            const ss = (card.querySelector('.edit-ss-input')||{}).value||''; const ssV = ss.trim();
            const as = (card.querySelector('.edit-salary-input')||{}).value||''; const asV = as.trim();
            const tx = (card.querySelector('.edit-tax-input')||{}).value||''; const txV = tx.trim();
            const sb = (card.querySelector('.edit-sbank-input')||{}).value||''; const sbV = sb.trim();
            const ed = (card.querySelector('.edit-edu-input')||{}).value||'';
            const pr = (card.querySelector('.edit-prop-input')||{}).value||'';
            const pt = (card.querySelector('.edit-proptype-input')||{}).value||'';
            const pa = (card.querySelector('.edit-propaddr-input')||{}).value||''; const paV = pa.trim();
            const pAr = (card.querySelector('.edit-proparea-input')||{}).value||''; const pArV = pAr.trim();
            const pmb = (card.querySelector('.edit-propmbank-input')||{}).value||''; const pmbV = pmb.trim();
            const pma = (card.querySelector('.edit-propmamt-input')||{}).value||''; const pmaV = pma.trim();
            const po = (card.querySelector('.edit-propother-input')||{}).value||''; const poV = po.trim();
            const bd = (card.querySelector('.edit-bankdebt-input')||{}).value||''; const bdV = bd.trim();
            const cd = (card.querySelector('.edit-ccdebt-input')||{}).value||''; const cdV = cd.trim();
            const q3 = (card.querySelector('.edit-query-input')||{}).value||''; const q3V = q3.trim();
            const ol = (card.querySelector('.edit-onlineloan-input')||{}).value||''; const olV = ol.trim();
            const dm = (card.querySelector('.edit-demand-input')||{}).value||''; const dmV = dm.trim();
            const fg = (card.querySelector('.edit-fusage-input')||{}).value||''; const fgV = fg.trim();
            const vt = (card.querySelector('.edit-visittime-input')||{}).value||''; const vtV = vt.trim();
            const stV = (card.querySelector('.edit-status-input')||{}).value||'';
            const ab = (card.querySelector('.edit-approvedbank-input')||{}).value||''; const abV = ab.trim();
            const aa = (card.querySelector('.edit-approvedamount-input')||{}).value||''; const aaV = aa.trim();
            const rt = (card.querySelector('.edit-rateterm-input')||{}).value||''; const rtV = rt.trim();
            const rb = (card.querySelector('.edit-rejectedbank-input')||{}).value||''; const rbV = rb.trim();
            const rr = (card.querySelector('.edit-rejectreason-input')||{}).value||''; const rrV = rr.trim();

            if (!n) { alert('姓名不能为空，请填写完整！'); return; }
            if (!p) { alert('电话号码不能为空，请填写完整！'); return; }
            if (!label) { alert('请选择客户等级（A/B/C 类），此项为必选！'); return; }
            if (!nt) { alert('沟通记录为必填项，请填写完整！'); return; }

            const allList = JSON.parse(localStorage.getItem(CLIENTS_K) || '[]');
            const matchIdx = allList.findIndex(item => item.date === ds && item.name === ti.name && item.phone === ti.phone &&
              (ti.time ? item.time === ti.time : true));
            const updatedClient = {
              date: ds, time: fullClient.time || ti.time || getCurrentTime(),
              name: n, phone: p, company: comp, fund: fund, label: label, note: nt,
              followUps: newFollowUpsTl, followUp: fuSplitTl.followUp,
              age: ageV, maritalStatus: ms, isShenzhenHukou: sh, socialSecurity: ssV,
              avgSalary: asV, tax2yr: txV, salaryBank: sbV, education: ed, property: pr,
              propertyType: pt, propertyAddress: paV, propertyArea: pArV, propertyMortgageBank: pmbV, propertyMortgageAmount: pmaV, propertyOther: poV,
              bankDebt: bdV, creditCardDebt: cdV, query3m: q3V, onlineLoanCount: olV,
              demand: dmV, fundUsage: fgV,
              visitTime: vtV, status: stV, approvedBank: abV, approvedAmount: aaV,
              rateTerm: rtV, rejectedBank: rbV, rejectReason: rrV
            };
            if (matchIdx !== -1) { allList[matchIdx] = updatedClient; }
            else { allList.push(updatedClient); }
            localStorage.setItem(CLIENTS_K, JSON.stringify(allList));

            await syncOp('updateClient', { matchName: ti.name, matchPhone: ti.phone, matchTime: ti.time || '', client: updatedClient }, ds);

            renderTl();
          };

          // Bind Cancel
          card.querySelector('.cancel-timeline-client-btn').onclick = () => { renderTl(); };
        };
      });
    }
    function bindFollowupBtns(){
      document.querySelectorAll('.tl-add-followup-btn').forEach(function(btn){
        btn.onclick = function(){
          var card = btn.closest('.client-card-item');
          var form = card.querySelector('.tl-followup-inline-form');
          var input = card.querySelector('.tl-followup-inline-input');
          if (form.style.display === 'none' || !form.style.display) {
            form.style.display = 'block';
            input.value = '';
            input.focus();
          } else {
            form.style.display = 'none';
          }
        };
      });
      document.querySelectorAll('.tl-followup-save-btn').forEach(function(btn){
        btn.onclick = async function(){
          var idx = parseInt(this.dataset.idx);
          var ti = timeline.find(function(t){ return t.type === 'client' && t.idx === idx; });
          if (!ti) return;
          var card = btn.closest('.client-card-item');
          var input = card.querySelector('.tl-followup-inline-input');
          var content = input.value.trim();
          if (!content) { alert('请输入跟进内容'); return; }
          var allList = JSON.parse(localStorage.getItem(CLIENTS_K) || '[]');
          var matchIdx = allList.findIndex(function(c){
            return c.date === ds && c.name === ti.name && c.phone === ti.phone && (ti.time ? c.time === ti.time : true);
          });
          if (matchIdx < 0) return;
          var client = allList[matchIdx];
          if (!client.followUps) client.followUps = [];
          client.followUps.push({ date: getTodayStr(), time: getCurrentTime(), content: content });
          allList[matchIdx] = client;
          localStorage.setItem(CLIENTS_K, JSON.stringify(allList));
          await syncOp('updateClient', { matchName: ti.name, matchPhone: ti.phone, matchTime: ti.time || '', client: client }, ds);
          renderTl();
        };
      });
      document.querySelectorAll('.tl-followup-cancel-btn').forEach(function(btn){
        btn.onclick = function(){
          var card = btn.closest('.client-card-item');
          var form = card.querySelector('.tl-followup-inline-form');
          form.style.display = 'none';
        };
      });
    }
    function bindDeleteBtns(){
      document.querySelectorAll('.delete-timeline-client-btn').forEach(btn=>{
        btn.onclick=async function(){
          const idx=parseInt(this.dataset.idx);
          const ti=timeline.find(t=>t.type==='client'&&t.idx===idx);
          if(!ti)return;
          const pin=prompt('删除客户「' + ti.name + '」需输入解锁密码：');
          if(!pin){return;}
          if(hashPinSimple(pin)!==getPinHash()){alert('密码错误，删除取消');return;}
          const allList=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
          const matchIdx=allList.findIndex(c=>c.date===ds&&c.name===ti.name&&c.phone===ti.phone&&(ti.time?c.time===ti.time:true));
          if(matchIdx>=0) allList.splice(matchIdx,1);
          localStorage.setItem(CLIENTS_K,JSON.stringify(allList));
          await syncOp('removeClientByMatch',{name:ti.name,phone:ti.phone,time:ti.time||''},ds);
          renderTl();
        };
      });
    }
    renderTl();
  }

  async function syncCalendarFromCloud(){
    const month=calendarMonth;
    const cal=await cloudCalendar(month);
    if(cal){
      const wm=loadMap(WECHAT_K), im=loadMap(INTENT_K), rm=loadMap(REVISIT_K), vm=loadMap(VISIT_K), pm=loadMap(PAYMENT_K), tm=loadMap(TEMP_CLIENTS_MAP_K);
      let changed=false;
      for(const [date, d] of Object.entries(cal)){
        const nw = Math.max(wm[date]||0, d.w||0);
        if(nw !== (wm[date]||0)){ wm[date]=nw; changed=true; }
        const ni = Math.max(im[date]||0, d.i||0);
        if(ni !== (im[date]||0)){ im[date]=ni; changed=true; }
        const nr = Math.max(rm[date]||0, d.r||0);
        if(nr !== (rm[date]||0)){ rm[date]=nr; changed=true; }
        const nv = Math.max(vm[date]||0, d.v||0);
        if(nv !== (vm[date]||0)){ vm[date]=nv; changed=true; }
        const np = Math.max(pm[date]||0, d.p||0);
        if(np !== (pm[date]||0)){ pm[date]=np; changed=true; }
        const nt = Math.max(tm[date]||0, d.t||0);
        if(nt !== (tm[date]||0)){ tm[date]=nt; changed=true; }
      }
      if(changed){saveMap(WECHAT_K,wm);saveMap(INTENT_K,im);saveMap(REVISIT_K,rm);saveMap(VISIT_K,vm);saveMap(PAYMENT_K,pm);saveMap(TEMP_CLIENTS_MAP_K,tm);}
      addSyncLog('✅ 拉取云端历史日历完成');
    }
  }

  const SHOW_GOAL_NUM_K='show_goal_num_v1';
  var chipMeta = {
    '本周上门': { mapKey: VISIT_K, agg: 'week', field: 'weeklyVisit' },
    '本周微信': { mapKey: WECHAT_K, agg: 'week', field: 'weeklyWechat' },
    '本月微信': { mapKey: WECHAT_K, agg: 'month', field: 'monthlyWechat' },
    '本月上门': { mapKey: VISIT_K, agg: 'month', field: 'monthlyVisit' },
    '本月回款': { mapKey: PAYMENT_K, agg: 'month', field: 'monthlyPayment' }
  };
  function renderGoalChips(){
    var container=document.getElementById('goalChips');
    if(!container)return;
    var showNum=localStorage.getItem(SHOW_GOAL_NUM_K)==='true';
    var eyeBtn=document.getElementById('goalEyeBtn');
    if(eyeBtn){
      eyeBtn.className='goal-eye'+(showNum?'':' eye-off');
      eyeBtn.title=showNum?'隐藏目标数字':'显示目标数字';
    }
    var wm=loadMap(WECHAT_K),vm=loadMap(VISIT_K),pm=loadMap(PAYMENT_K);
    var goals=loadGoals();
    var html='';
    var chipDefs = [
      { label:'本周上门', actual:getWeekTotal(vm), target:goals.weeklyVisit },
      { label:'本周微信', actual:getWeekTotal(wm), target:goals.weeklyWechat },
      { label:'本月微信', actual:getMonthTotal(wm,calendarMonth), target:goals.monthlyWechat },
      { label:'本月上门', actual:getMonthTotal(vm,calendarMonth), target:goals.monthlyVisit },
      { label:'本月回款', actual:getMonthTotal(pm,calendarMonth), target:goals.monthlyPayment }
    ];
    chipDefs.forEach(function(d){
      if(!d.target||d.target<=0||!showNum){
        html+='<span class="goal-chip" data-meta="'+d.label+'">'+d.label+'</span>';
        return;
      }
      var pct=Math.round(d.actual/d.target*100);
      var cls=pct>=100?'goal-met':pct>=50?'goal-half':'goal-low';
      html+='<span class="goal-chip '+cls+'" data-meta="'+d.label+'">'+d.label+' <b class="goal-actual" data-meta="'+d.label+'" title="点击编辑完成数">'+d.actual+'</b>/<i class="goal-target" data-meta="'+d.label+'" title="点击编辑目标">'+d.target+'</i></span>';
    });
    container.innerHTML=html;
  }
  // 统一 click 委托
  (function(){
    var container=document.getElementById('goalChips');
    if(!container)return;
    container.addEventListener('click',function(e){
      // 点击完成数（粗体）→ 原地编辑
      var actEl=e.target.closest('.goal-actual');
      if(actEl){
        e.stopPropagation();
        var label=actEl.dataset.meta;
        var cfg=chipMeta[label];
        if(!cfg)return;
        var cur=parseInt(actEl.textContent,10)||0;
        var inp=document.createElement('input');
        inp.type='number';inp.min='0';inp.value=cur;
        inp.style.cssText='width:44px;padding:1px 4px;font-size:0.75rem;font-weight:700;text-align:center;border:1px solid var(--accent-wechat);border-radius:3px;background:var(--card-bg);color:var(--text-main);outline:none;';
        inp.onblur=function(){
          var nv=parseInt(inp.value,10)||0;
          if(nv!==cur){
            var delta=nv-cur;
            var today=getTodayStr();
            var mp=loadMap(cfg.mapKey);
            mp[today]=(mp[today]||0)+delta;
            if(mp[today]<0)mp[today]=0;
            saveMap(cfg.mapKey,mp);
            syncOp('setMap',{mapKey:cfg.mapKey,date:today,value:mp[today]});
          }
          renderGoalChips();
        };
        inp.onkeydown=function(ev){if(ev.key==='Enter')inp.blur();};
        actEl.replaceWith(inp);
        inp.focus();inp.select();
        return;
      }
      // 点击目标数（斜体）→ 打开目标设定弹窗
      var tgtEl=e.target.closest('.goal-target');
      if(tgtEl){
        e.stopPropagation();
        var label=tgtEl.dataset.meta;
        var cfg=chipMeta[label];
        var goals=loadGoals();
        document.getElementById('goalWeeklyVisit').value=goals.weeklyVisit||'';
        document.getElementById('goalWeeklyWechat').value=goals.weeklyWechat||'';
        document.getElementById('goalMonthlyWechat').value=goals.monthlyWechat||'';
        document.getElementById('goalMonthlyVisit').value=goals.monthlyVisit||'';
        document.getElementById('goalMonthlyPayment').value=goals.monthlyPayment||'';
        document.getElementById('goalStatus').textContent='';
        document.getElementById('goalModal').classList.add('active');
        var focusMap={weeklyVisit:'goalWeeklyVisit',weeklyWechat:'goalWeeklyWechat',monthlyWechat:'goalMonthlyWechat',monthlyVisit:'goalMonthlyVisit',monthlyPayment:'goalMonthlyPayment'};
        var fid=focusMap[cfg.field];
        if(fid){setTimeout(function(){var el=document.getElementById(fid);if(el){el.focus();el.select();}},100);}
        return;
      }
    });
  })();
  function toggleGoalNumbers(){
    const cur=localStorage.getItem(SHOW_GOAL_NUM_K)==='true';
    localStorage.setItem(SHOW_GOAL_NUM_K,!cur);
    renderGoalChips();
  }

  // ===== 内容展示模块（复制粘贴保留格式） =====
  var _pastes=[], _curPasteId='', _pasteInited=false;
  var _pasteHtmlCache={};

  function initPasteModule(){
    if(_pasteInited) return;
    _pasteInited=true;
    var addBtn=document.getElementById('pasteManageAddBtn');
    if(addBtn) addBtn.addEventListener('click',openPasteEditor);
    var closeBtn=document.getElementById('closePasteModalBtn');
    if(closeBtn) closeBtn.addEventListener('click',closePasteEditor);
    var cancelBtn=document.getElementById('pasteCancelBtn');
    if(cancelBtn) cancelBtn.addEventListener('click',closePasteEditor);
    var saveBtn=document.getElementById('pasteSaveBtn');
    if(saveBtn) saveBtn.addEventListener('click',savePaste);
    var modal=document.getElementById('pasteModal');
    if(modal) modal.addEventListener('click',function(e){ if(e.target===modal) closePasteEditor(); });
    document.addEventListener('keydown',function(e){
      if(e.key==='Escape') closePasteEditor();
    });
    var prevBtn=document.getElementById('pasteArrowPrev');
    if(prevBtn) prevBtn.addEventListener('click',function(){ navPaste(-1); pokePasteArrows(); });
    var nextBtn=document.getElementById('pasteArrowNext');
    if(nextBtn) nextBtn.addEventListener('click',function(){ navPaste(1); pokePasteArrows(); });
    var pv=document.getElementById('pasteView');
    if(pv) pv.addEventListener('click',function(){ pokePasteArrows(); });
    refreshPasteList();
  }

  // 沉浸式左右箭头：显示可用方向的箭头，2.5秒后自动隐藏
  var _pasteArrowTimer=null;
  function pokePasteArrows(){
    var prevBtn=document.getElementById('pasteArrowPrev');
    var nextBtn=document.getElementById('pasteArrowNext');
    if(!prevBtn||!nextBtn) return;
    prevBtn.classList.remove('show');
    nextBtn.classList.remove('show');
    if(_pastes.length<=1) return;
    var idx=-1;
    for(var i=0;i<_pastes.length;i++){ if(_pastes[i].id===_curPasteId){ idx=i; break; } }
    if(idx<0) idx=0;
    if(idx>0) prevBtn.classList.add('show');
    if(idx<_pastes.length-1) nextBtn.classList.add('show');
    if(_pasteArrowTimer) clearTimeout(_pasteArrowTimer);
    _pasteArrowTimer=setTimeout(function(){
      var p=document.getElementById('pasteArrowPrev');
      var n=document.getElementById('pasteArrowNext');
      if(p)p.classList.remove('show');
      if(n)n.classList.remove('show');
    },2500);
  }

  function navPaste(dir){
    if(_pastes.length===0) return;
    var idx=-1;
    for(var i=0;i<_pastes.length;i++){ if(_pastes[i].id===_curPasteId){ idx=i; break; } }
    if(idx<0) idx=0;
    var ni=idx+dir;
    if(ni<0||ni>=_pastes.length) return;
    selectPaste(_pastes[ni].id);
  }

  function openPasteEditor(){
    var modal=document.getElementById('pasteModal');
    var editor=document.getElementById('pasteEditor');
    if(editor) editor.innerHTML='';
    if(modal) modal.classList.add('active');
    setTimeout(function(){ if(editor) editor.focus(); },50);
  }

  function closePasteEditor(){
    var modal=document.getElementById('pasteModal');
    if(modal) modal.classList.remove('active');
  }

  // 负边距/负缩进会突破容器内边距贴到圆角边缘被裁切，钳制为 0
  function clampNegativeLayout(el){
    var style=el.getAttribute('style')||'';
    if(!style) return;
    var newStyle=style.replace(/(^|;)\\s*(margin-left|margin-right|text-indent)\\s*:\\s*(-[\\d.]+)(pt|px|em)/gi,function(m,pre,prop){
      return pre+prop+':0';
    });
    if(newStyle!==style) el.setAttribute('style',newStyle);
  }

  // 字号归一化：pt/px 统一转 px 并按 0.82 等比缩小（保留标题与正文的层次）
  function normalizeFontSizes(el){
    var style=el.getAttribute('style')||'';
    if(!style) return;
    // 前导约束 (^|;)\s* 避免误匹配 mso-ansi-font-size 等 mso 属性
    var newStyle=style.replace(/(^|;)\\s*font-size\\s*:\\s*([\\d.]+)(pt|px)/gi,function(m,pre,num,unit){
      var px=unit==='pt'?parseFloat(num)*4/3:parseFloat(num);
      if(!px||isNaN(px)||px<=0) return m;
      px=Math.round(px*0.82*10)/10;
      return pre+'font-size:'+px+'px';
    });
    if(newStyle!==style) el.setAttribute('style',newStyle);
  }

  // 清洗粘贴的富文本：去掉 script/事件属性/mso 噪音，保留字体、字间距、行距、缩进等格式
  function cleanPastedHtml(html){
    try {
      var doc=new DOMParser().parseFromString(String(html||''),'text/html');
      ['script','style','iframe','object','embed','link','meta','base','form','input','button','textarea','select'].forEach(function(tag){
        doc.querySelectorAll(tag).forEach(function(el){ el.remove(); });
      });
      // 移除 VML 图形元素（v:shape/v:line/o:... 等 Word 形状/箭头/线条，
      // 现代浏览器不渲染，残留会变成空白）与 xml 命名空间节点
      doc.querySelectorAll('*').forEach(function(el){
        var tag=el.tagName.toLowerCase();
        if(tag.indexOf(':')!==-1||tag==='xml'){ el.remove(); }
      });
      // 移除加载不了的图片（Word 复制图片的 src 是本地 file:// 路径，
      // 网页端无法加载会显示占位图/破图；data: 内联图片可保留）
      doc.querySelectorAll('img').forEach(function(el){
        var src=(el.getAttribute('src')||'').trim();
        if(src.indexOf('data:')!==0) el.remove();
      });
      // 移除全部注释（含 Word 的条件注释 <!--[if gte mso 9]>...<![endif]-->）
      try {
        var tw=doc.createTreeWalker(doc,NodeFilter.SHOW_COMMENT,{acceptNode:function(){return NodeFilter.FILTER_ACCEPT;}});
        var comments=[];
        while(tw.nextNode()) comments.push(tw.currentNode);
        for(var ci=0;ci<comments.length;ci++){ if(comments[ci].parentNode) comments[ci].parentNode.removeChild(comments[ci]); }
      } catch(e2) {}
      doc.querySelectorAll('*').forEach(function(el){
        var attrs=[].slice.call(el.attributes||[]);
        for(var i=0;i<attrs.length;i++){
          var n=attrs[i].name;
          if(/^on/i.test(n)||/^mso-/i.test(n)||/^xmlns/i.test(n)) el.removeAttribute(n);
        }
        normalizeFontSizes(el);
        clampNegativeLayout(el);
      });
      return doc.body?doc.body.innerHTML:'';
    } catch(e){ return ''; }
  }

  // 每 60 秒（refreshAll 末尾）调用；只拉清单，选中项未变不重渲染
  async function refreshPasteList(){
    try {
      var resp=await fetch('/api/paste');
      var pastes=await resp.json();
      _pastes=Array.isArray(pastes)?pastes:[];
      renderPasteList();
      if(_curPasteId && _pastes.some(function(p){return p.id===_curPasteId;})) return;
      if(_pastes.length){
        // 恢复上次查看的内容，否则选第一篇
        var saved='';
        try { saved=localStorage.getItem('paste_cur_id')||''; } catch(e){}
        var savedPaste=null;
        for(var i=0;i<_pastes.length;i++){ if(_pastes[i].id===saved){ savedPaste=_pastes[i]; break; } }
        selectPaste(savedPaste?savedPaste.id:_pastes[0].id);
      } else {
        showPasteEmpty();
      }
    } catch(e) { console.error('加载内容列表失败:',e); }
  }

  function renderPasteList(){
    // 管理列表在学习管理弹窗内（竖排条目），页面卡片只做展示
    var list=document.getElementById('pasteManageList');
    var card=document.querySelector('.paste-card');
    if(card) card.classList.toggle('empty',_pastes.length===0);
    if(!list) return;
    list.innerHTML='';
    if(_pastes.length===0){
      list.innerHTML='<div class="paste-manage-empty">暂无内容，点击上方"添加内容"粘贴保存</div>';
      return;
    }
    for(var i=0;i<_pastes.length;i++){
      var p=_pastes[i];
      var item=document.createElement('div');
      item.className='paste-manage-item'+(p.id===_curPasteId?' selected':'');
      item.dataset.pasteId=p.id;
      var nameSpan=document.createElement('span');
      nameSpan.className='paste-manage-name';
      nameSpan.textContent=p.name||'内容 '+(i+1);
      var delBtn=document.createElement('button');
      delBtn.type='button';
      delBtn.className='paste-manage-del';
      delBtn.textContent='✕';
      delBtn.dataset.pasteId=p.id;
      item.appendChild(nameSpan);
      item.appendChild(delBtn);
      item.addEventListener('click',function(){
        selectPaste(this.dataset.pasteId);
        // 关闭学习管理，回到页面看展示效果
        var lm=document.getElementById('learnModal');
        if(lm) lm.classList.remove('active');
      });
      delBtn.addEventListener('click',function(e){ e.stopPropagation(); deletePaste(this.dataset.pasteId); });
      list.appendChild(item);
    }
    pokePasteArrows();
  }

  function showPasteEmpty(){
    _curPasteId='';
    var card=document.querySelector('.paste-card');
    if(card) card.classList.add('empty');
    var view=document.getElementById('pasteView');
    if(view){ view.innerHTML=''; }
    pokePasteArrows();
  }

  function selectPaste(id){
    _curPasteId=id;
    try { localStorage.setItem('paste_cur_id',id); } catch(e){}
    renderPasteList();
    renderIntoView(id);
  }

  function renderIntoView(id){
    var view=document.getElementById('pasteView');
    if(!view) return;
    var card=document.querySelector('.paste-card');
    if(card) card.classList.remove('empty');
    if(_pasteHtmlCache[id]!==undefined){
      view.innerHTML=_pasteHtmlCache[id];
      return;
    }
    view.innerHTML='<div class="paste-loading">加载中…</div>';
    fetch('/api/paste/'+encodeURIComponent(id)).then(function(r){
      if(!r.ok) throw new Error('加载失败('+r.status+')');
      return r.text();
    }).then(function(html){
      _pasteHtmlCache[id]=html;
      if(_curPasteId!==id) return;
      view.innerHTML=html||'';
    }).catch(function(e){
      if(_curPasteId!==id) return;
      view.innerHTML='<div class="paste-error">内容加载失败</div>';
      console.error('加载内容失败:',e);
    });
  }

  async function savePaste(){
    var editor=document.getElementById('pasteEditor');
    var saveBtn=document.getElementById('pasteSaveBtn');
    if(!editor) return;
    var text=(editor.innerText||'').trim();
    if(!text){
      alert('请先粘贴内容');
      return;
    }
    var html=cleanPastedHtml(editor.innerHTML);
    var name=text.substring(0,14);
    if(saveBtn) saveBtn.disabled=true;
    try {
      var resp=await fetch('/api/paste',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:name,html:html})
      });
      var result=await resp.json();
      if(!result.ok){ alert('保存失败: '+(result.error||'未知错误')); return; }
      closePasteEditor();
      await refreshPasteList();
      selectPaste(result.id);
    } catch(e) { console.error('保存内容失败:',e); alert('保存失败: '+e.message); }
    finally { if(saveBtn) saveBtn.disabled=false; }
  }

  async function deletePaste(id){
    var p=null;
    for(var i=0;i<_pastes.length;i++){ if(_pastes[i].id===id){ p=_pastes[i]; break; } }
    var name=p?p.name:'该内容';
    if(!confirm('确定删除「'+name+'」吗？')) return;
    try {
      var resp=await fetch('/api/paste',{
        method:'DELETE',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:id})
      });
      var result=await resp.json();
      if(!result.ok){ alert('删除失败: '+(result.error||'未知错误')); return; }
      delete _pasteHtmlCache[id];
      if(_curPasteId===id) _curPasteId='';
      await refreshPasteList();
    } catch(e) { console.error('删除内容失败:',e); }
  }

  function refreshAll(){
    const wm=loadMap(WECHAT_K),im=loadMap(INTENT_K),rm=loadMap(REVISIT_K),vm=loadMap(VISIT_K),pm=loadMap(PAYMENT_K),today=getTodayStr();
    // 意向计数直接从当日客户数派生，确保永远准确
    const allClients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const todayClients=allClients.filter(c=>c.date===today);
    const todayIntent=todayClients.length;
    im[today]=todayIntent;saveMap(INTENT_K,im);
    document.getElementById('wechatNum').innerText=wm[today]||0;
    document.getElementById('intentNum').innerText=todayIntent;
    document.getElementById('revisitNum').innerText=rm[today]||0;
    document.getElementById('weekWechat').innerText=getWeekTotal(wm);
    document.getElementById('monthWechat').innerText=getMonthTotal(wm);
    document.getElementById('weekIntent').innerText=getWeekTotal(im);
    document.getElementById('monthIntent').innerText=getMonthTotal(im);
    document.getElementById('weekRevisit').innerText=getWeekTotal(rm);
    document.getElementById('monthRevisit').innerText=getMonthTotal(rm);
    const now=new Date();const wk=['周日','周一','周二','周三','周四','周五','周六'];
    document.getElementById('liveDate').innerHTML=(now.getMonth()+1)+'月'+now.getDate()+'日 '+wk[now.getDay()];
    renderCalendar(wm,im);renderClientList();renderTodos();renderTempClientList();
    renderGoalChips();
    refreshPasteList();
  }

  async function modCounter(key,delta,op){
    // 直接在本地值基础上增减，立即响应；服务端原子写入保证多设备最终一致
    const t=getTodayStr();
    const d=loadMap(key);
    let v=Math.max((d[t]||0)+delta,0);
    if(v===0)delete d[t];else d[t]=v;saveMap(key,d);
    refreshAll();
    await syncOp(op||'incWechat',{delta});
  }
  async function resetToday(key,op){const d=loadMap(key);const t=getTodayStr();const old=d[t]||0;delete d[t];saveMap(key,d);refreshAll();if(old>0)await syncOp(op||'incWechat',{delta:-old});}

  function getElVal(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function clearEl(id) { const el = document.getElementById(id); if (el) el.value = ''; }
  async function addClient(){
    const n=document.getElementById('custName').value.trim();
    const p=document.getElementById('custPhone').value.trim();
    const c=document.getElementById('custCompany').value.trim();
    const f=document.getElementById('custFund').value.trim();
    const label=document.getElementById('custLabel').value;
    const nt=document.getElementById('custNote').value.trim();
    const fu=document.getElementById('custFollowUp').value.trim();
    // New detail fields
    const age = getElVal('custAge');
    const maritalStatus = getElVal('custMaritalStatus');
    const isShenzhenHukou = getElVal('custIsShenzhenHukou');
    const socialSecurity = getElVal('custSocialSecurity');
    const avgSalary = getElVal('custAvgSalary');
    const tax2yr = getElVal('custTax2yr');
    const salaryBank = getElVal('custSalaryBank');
    const education = getElVal('custEducation');
    const propertyVal = getElVal('custProperty');
    const propertyType = getElVal('custPropertyType');
    const propertyAddress = getElVal('custPropertyAddress');
    const propertyArea = getElVal('custPropertyArea');
    const propertyMortgageBank = getElVal('custPropertyMortgageBank');
    const propertyMortgageAmount = getElVal('custPropertyMortgageAmount');
    const propertyOther = getElVal('custPropertyOther');
    const bankDebt = getElVal('custBankDebt');
    const creditCardDebt = getElVal('custCreditCardDebt');
    const query3m = getElVal('custQuery3m');
    const onlineLoanCount = getElVal('custOnlineLoanCount');
    const demand = getElVal('custDemand');
    const fundUsage = getElVal('custFundUsage');
    const visitTime = getElVal('custVisitTime');
    const status = getElVal('custStatus');
    const approvedBank = getElVal('custApprovedBank');
    const approvedAmount = getElVal('custApprovedAmount');
    const rateTerm = getElVal('custRateTerm');
    const rejectedBank = getElVal('custRejectedBank');
    const rejectReason = getElVal('custRejectReason');
    if(!n){alert('姓名不能为空，请填写完整！');return;}
    if(!p){alert('电话号码不能为空，请填写完整！');return;}
    if(!label){alert('请选择客户等级（A/B/C 类），此项为必选！');return;}
    if(!nt){alert('沟通记录为必填项，请填写完整！');return;}
    const list=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const today=getTodayStr(),time=getCurrentTime();

    // Check if we're editing an existing entry (set by the "编" button handler)
    var editKey = window._editingClientKey;
    var oldEntry = null;
    if (editKey) {
      var parts = editKey.split('|');
      var oldName = parts[0], oldPhone = parts[1], oldTime = parts[2] || '';
      var oldIdx = list.findIndex(function(item) {
        return item.name === oldName && item.phone === oldPhone && (oldTime ? item.time === oldTime : true);
      });
      if (oldIdx >= 0) {
        oldEntry = list[oldIdx];
        list.splice(oldIdx, 1);
      }
      window._editingClientKey = null;
      // Reset add button
      var addBtn = document.getElementById('addClientBtn');
      if (addBtn) { addBtn.textContent = '+ 添加'; addBtn.style.background = 'var(--accent-btn)'; }
    }

    // 跟进记录：多行「[日期 时间] 内容」还原为多条记录（保留原日期时间），纯文本走旧 followUp 字段
    var fuSplit=splitFollowUpsText(fu);
    var newClient={name:n,phone:p,company:c,fund:f,label:label,note:nt,followUps:fuSplit.followUps,followUp:fuSplit.followUp,date:today,time:time,
      age,maritalStatus,isShenzhenHukou,socialSecurity,avgSalary,tax2yr,salaryBank,
      education,property:propertyVal,propertyType,propertyAddress,propertyArea,propertyMortgageBank,propertyMortgageAmount,propertyOther,
      bankDebt,creditCardDebt,query3m,onlineLoanCount,demand,fundUsage,
      visitTime,status,approvedBank,approvedAmount,rateTerm,rejectedBank,rejectReason,
      keyQuestions:getKeyQuestionsFromForm('kq_')};
    // Preserve original date+time when editing (keep the record on its original day)
    if (oldEntry && oldEntry.date) { newClient.date = oldEntry.date; newClient.time = oldEntry.time || time; }
    list.push(newClient);
    localStorage.setItem(CLIENTS_K,JSON.stringify(list));
    clearEl('custName'); clearEl('custPhone'); clearEl('custCompany'); clearEl('custFund');
    var labelEl = document.getElementById('custLabel'); if (labelEl) labelEl.value = '';
    clearEl('custNote'); clearEl('custFollowUp');
    clearEl('custAge'); clearEl('custMaritalStatus'); clearEl('custIsShenzhenHukou');
    clearEl('custSocialSecurity'); clearEl('custAvgSalary'); clearEl('custTax2yr');
    clearEl('custSalaryBank'); clearEl('custEducation'); clearEl('custProperty');
    clearEl('custPropertyType'); clearEl('custPropertyAddress'); clearEl('custPropertyArea');
    clearEl('custPropertyMortgageBank'); clearEl('custPropertyMortgageAmount'); clearEl('custPropertyOther');
    clearEl('custBankDebt'); clearEl('custCreditCardDebt'); clearEl('custQuery3m');
    clearEl('custOnlineLoanCount'); clearEl('custDemand'); clearEl('custFundUsage');
    clearEl('custVisitTime'); clearEl('custApprovedBank'); clearEl('custApprovedAmount');
    clearEl('custRateTerm'); clearEl('custRejectedBank'); clearEl('custRejectReason');
    var stEl = document.getElementById('custStatus'); if (stEl) stEl.value = '';
    showStatusConditionalFields('');
    var kqEl=document.getElementById('keyQuestionsIntent'); if(kqEl)kqEl.innerHTML=renderKeyQuestionsHTML('kq_',[]);
    renderClientList();refreshAll();
    // Sync: remove old entry first if editing, then add the new one
    if (oldEntry) {
      await syncOp('removeClientByMatch',{name:oldEntry.name,phone:oldEntry.phone,time:oldEntry.time||''});
    }
    await syncOp('addClient',{client:newClient});
    // Collapse detail panel after adding
    var dp = document.getElementById('detailPanel');
    var dt = document.getElementById('detailToggleBtn');
    if (dp && dp.style.display !== 'none') {
      dp.style.display = 'none';
      if (dt) {
        var icon = dt.querySelector('.detail-toggle-icon');
        if (icon) icon.classList.remove('open');
        dt.innerHTML = '<span class="detail-toggle-icon">▶</span> 详细资料';
      }
    }
  }

  var _tempEditIdx=-1; // -1=新增模式, >=0=编辑索引
  function tempEditClient(idx){
    var list=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
    if(idx<0||idx>=list.length) return;
    var c=list[idx];
    document.getElementById('tempCustName').value=c.name;
    document.getElementById('tempCustPhone').value=c.phone;
    document.getElementById('tempCustCompany').value=c.company||'';
    document.getElementById('tempCustFund').value=c.fund||'';
    document.getElementById('tempCustNote').value=c.note||'';
    var tkqEl=document.getElementById('keyQuestionsTemp'); if(tkqEl)tkqEl.innerHTML=renderKeyQuestionsHTML('tkq_',c.keyQuestions||[]);
    if(c.keyQuestions && c.keyQuestions.length>0){
      var tkqp=document.getElementById('tkqPanel'); if(tkqp)tkqp.style.display='flex';
      var tkqBtn=document.getElementById('tkqToggleBtn'); if(tkqBtn)tkqBtn.innerHTML='<span class="detail-toggle-icon open">▶</span> 收起关键问题勾选';
    }
    _tempEditIdx=idx;
    var btn=document.getElementById('addTempCustBtn');
    if(btn){ btn.textContent='✓ 更新'; btn.style.background='var(--accent-intent)'; }
    var cancelBtn=document.getElementById('cancelTempEditBtn');
    if(cancelBtn) cancelBtn.style.display='inline-block';
    document.getElementById('tempCustName').focus();
  }
  function tempCancelEdit(){
    _tempEditIdx=-1;
    document.getElementById('tempCustName').value='';
    document.getElementById('tempCustPhone').value='';
    document.getElementById('tempCustCompany').value='';
    document.getElementById('tempCustFund').value='';
    document.getElementById('tempCustNote').value='';
    var tkqEl=document.getElementById('keyQuestionsTemp'); if(tkqEl)tkqEl.innerHTML=renderKeyQuestionsHTML('tkq_',[]);
    var tkqp=document.getElementById('tkqPanel'); if(tkqp)tkqp.style.display='none';
    var tkqBtn=document.getElementById('tkqToggleBtn'); if(tkqBtn)tkqBtn.innerHTML='<span class="detail-toggle-icon">▶</span> 关键问题勾选';
    var btn=document.getElementById('addTempCustBtn');
    if(btn){ btn.textContent='+ 登记'; btn.style.background='var(--accent-btn)'; }
    var cancelBtn=document.getElementById('cancelTempEditBtn');
    if(cancelBtn) cancelBtn.style.display='none';
  }
  async function addTempClient(){
    const n=document.getElementById('tempCustName').value.trim();
    const p=document.getElementById('tempCustPhone').value.trim();
    const co=document.getElementById('tempCustCompany').value.trim();
    const fu=document.getElementById('tempCustFund').value.trim();
    const nt=document.getElementById('tempCustNote').value.trim();
    if(!n||!p){alert('请填写姓名和联系方式');return;}
    const list=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
    const today=getTodayStr(),time=getCurrentTime();
    var keyQuestions=getKeyQuestionsFromForm('tkq_');
    const newClient={name:n,phone:p,company:co,fund:fu,note:nt,date:today,time:time,keyQuestions:keyQuestions};
    if(_tempEditIdx>=0&&_tempEditIdx<list.length){
      // 编辑模式：保留原日期时间、跟进记录
      var old=list[_tempEditIdx];
      newClient.date=old.date;
      newClient.time=old.time;
      if(old.followUps) newClient.followUps=old.followUps;
      list[_tempEditIdx]=newClient;
    } else {
      list.push(newClient);
    }
    localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(list));
    tempCancelEdit();
    renderTempClientList();
    await syncOp('setTempClients',{tempClients:list});
  }

  function renderTempClientList(){
    var all=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
    var today=getTodayStr();
    var list=all.filter(function(tc){return tc.date===today;});
    var container = document.getElementById('tempClientList');
    if(!container) return;
    if(list.length===0){
      container.innerHTML='<div class="empty-clients">暂无临时登记客户</div>';
      return;
    }
    container.innerHTML=list.map((c,i)=>{
      var fullIdx=all.indexOf(c);
      return '<div class="client-card-item">'+
        '<div class="client-card-top">'+
          '<div class="client-card-primary">'+
            '<span class="client-card-name">'+esc(c.name)+'</span>'+
            '<span class="client-card-phone-wrap">'+
              '<a class="client-phone" href="tel:'+esc(c.phone)+'" data-full="'+esc(c.phone)+'">'+esc(maskPhone(c.phone))+'</a>'+
              '<button class="phone-toggle" title="显示号码">看</button>'+
            '</span>'+
          '</div>'+
          (c.time ? '<span class="client-card-time">'+esc(c.time)+'</span>' : '')+
        '</div>'+
        '<div class="client-card-body">'+
          (c.company||c.fund ? '<div class="client-card-content-block">'+
            '<span class="client-card-label">信息</span>'+
            '<span class="client-card-text">'+esc([c.company||'',c.fund?'公积金:'+c.fund:''].filter(Boolean).join(' | '))+'</span>'+
          '</div>' : '')+
          formatKqDisplay(c.keyQuestions)+
          '<div class="client-card-content-block">'+
            '<span class="client-card-label">回访备注</span>'+
            '<span class="client-card-text">'+esc(c.note||'')+'</span>'+
          '</div>'+
        '</div>'+
        '<div class="client-card-actions">'+
          '<button class="edit-temp-btn temp-tbl-edit" data-idx="'+fullIdx+'" title="编辑"><svg width="15" height="15" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 3l2 2L6 13.5H3.5v-2.5L11.5 3z"/></svg></button>'+
          '<button class="convert-temp-btn" data-idx="'+fullIdx+'" title="转为正式意向客户" style="font-size:1.1rem;padding:0;background:none;border:none;color:var(--accent-intent);cursor:pointer;margin-right:8px;font-weight:700;">→</button>'+
          '<button class="del-temp-btn temp-tbl-del" data-idx="'+fullIdx+'" title="删除"><svg width="15" height="15" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5l8 8M12.5 4.5l-8 8"/></svg></button>'+
        '</div>'+
      '</div>';
    }).join('');
    
    // 绑定删除按钮
    container.querySelectorAll('.del-temp-btn').forEach(b=>{
      b.onclick=async function(){
        const idx=parseInt(this.dataset.idx);
        const a=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
        if(isNaN(idx)||idx<0||idx>=a.length) return;
        if(!confirm('删除 '+a[idx].name+' ?')) return;
        a.splice(idx,1);
        localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(a));
        renderTempClientList();
        await syncOp('setTempClients',{tempClients:a});
      };
    });

    // 绑定编辑按钮
    container.querySelectorAll('.edit-temp-btn').forEach(function(b){
      b.onclick=function(e){
        e.stopPropagation();
        var idx=parseInt(this.dataset.idx);
        tempEditClient(idx);
      };
    });

    // 绑定转意向按钮
    container.querySelectorAll('.convert-temp-btn').forEach(b=>{
      b.onclick=async function(){
        const idx=parseInt(this.dataset.idx);
        const a=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
        const c=a[idx];
        
        // 填充正式客户登记输入框
        document.getElementById('custName').value=c.name;
        document.getElementById('custPhone').value=c.phone;
        document.getElementById('custNote').value=c.note||'';
        document.getElementById('custCompany').value=c.company||'';
        document.getElementById('custFund').value=c.fund||'';
        
        // 从临时列表中删除
        a.splice(idx,1);
        localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(a));
        renderTempClientList();
        await syncOp('setTempClients',{tempClients:a});
        
        // 聚焦姓名输入框，方便用户补充单位/公积金并点击添加
        document.getElementById('custName').focus();
        
        // 正式卡片微缩放动画高亮
        const card = document.getElementById('custName').closest('.card');
        if(card){
          card.style.transform = 'scale(1.02)';
          card.style.transition = 'all 0.3s';
          setTimeout(() => card.style.transform = 'none', 500);
        }
      };
    });

    // 绑定手机号切换
    container.querySelectorAll('.phone-toggle').forEach(b=>b.addEventListener('click',e=>{
      e.stopPropagation();
      const phoneSpan=b.previousElementSibling;
      const full=phoneSpan.dataset.full;
      if(phoneSpan.textContent===full){
        phoneSpan.textContent=maskPhone(full);
        b.title='显示号码';
        b.textContent='看';
      }else{
        phoneSpan.textContent=full;
        b.title='隐藏号码';
        b.textContent='隐';
      }
    }));
  }

  // ===== 临时登记全量表 =====
  async function renderTempFullTable(){
    var list=[];
    // 优先从云端拉取全量临时客户
    try{
      var r=await fetch('/api/all-temp-clients');
      if(r.ok){
        list=await r.json();
        // 合并本地跟进记录：保留本地未同步到云端的 followUps，防止拉取覆盖丢失
        var localList=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
        var localMap=new Map();
        localList.forEach(function(lc){
          localMap.set(lc.name+'|'+lc.phone+'|'+(lc.date||'')+'|'+(lc.time||''),lc);
        });
        list.forEach(function(c){
          var key=c.name+'|'+c.phone+'|'+(c.date||'')+'|'+(c.time||'');
          var local=localMap.get(key);
          if(local&&local.followUps&&local.followUps.length>0){
            c.followUps=local.followUps;
          }
        });
        localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(list));
      }
    }catch(e){}
    if(list.length===0){
      list=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
    }
    // 渲染前去重：防止历史脏数据重复显示
    {
      var seenFull=new Set();
      list=list.filter(function(c){
        var k=(c.name||'')+'|'+(c.phone||'')+'|'+(c.date||'')+'|'+(c.time||'');
        if(seenFull.has(k)) return false;
        seenFull.add(k);
        return true;
      });
    }
    var cardList=document.getElementById('tempFullCardList');
    var count=document.getElementById('tempFullCount');
    if(!cardList) return;
    if(count) count.textContent='('+list.length+'人)';
    if(list.length===0){
      cardList.innerHTML='<div style="text-align:center;color:var(--text-light);padding:32px;font-size:0.85rem;">暂无临时登记客户</div>';
      return;
    }
    // 按日期倒序排列
    list.sort(function(a,b){ return (b.date||'').localeCompare(a.date||'')||(b.time||'').localeCompare(a.time||''); });
    var cardHtml='';
    for(var i=0;i<list.length;i++){
      var c=list[i];
      if(!c.followUps) c.followUps=[];
      var fuCount=c.followUps.length;
      var fuParts=[];
      for(var fi=0;fi<c.followUps.length;fi++){
        var fu=c.followUps[fi];
        fuParts.push('<div style="font-size:0.65rem;color:var(--text-soft);padding:2px 0;">'+esc(fu.date||'')+' '+esc(fu.time||'')+' '+esc(fu.content||'')+'</div>');
      }
      cardHtml+='<div class="temp-card">'+
        '<div class="temp-card-row"><span class="temp-card-no" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--accent-wechat);color:#fff;font-size:0.62rem;font-weight:800;flex-shrink:0;">'+(list.length-i)+'</span><span class="temp-card-date">'+esc(c.date||'')+'</span><span class="temp-card-time">'+esc(c.time||'')+'</span></div>'+
        '<div class="temp-card-row"><span class="temp-card-name">'+esc(c.name)+'</span><span class="temp-card-phone"><a href="tel:'+esc(c.phone)+'">'+esc(c.phone)+'</a></span><div class="temp-card-actions"><button class="temp-tbl-export" data-idx="'+i+'" title="导出"><svg width="15" height="15" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l7.5-7.5M5.5 5H12v6.5"/></svg></button><button class="temp-tbl-edit" data-key="'+esc(c.name)+'|'+esc(c.phone)+'" title="编辑"><svg width="15" height="15" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 3l2 2L6 13.5H3.5v-2.5L11.5 3z"/></svg></button><button class="temp-tbl-convert" data-idx="'+i+'" title="转为意向"><svg width="15" height="15" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5h11M10 6l3 2.5-3 2.5"/></svg></button><button class="temp-tbl-del" data-idx="'+i+'" title="删除"><svg width="15" height="15" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5l8 8M12.5 4.5l-8 8"/></svg></button></div></div>'+
        ((c.company||c.fund) ? '<div class="temp-card-row" style="gap:4px;">'+(c.company?'<span class="client-card-tag client-card-tag-company" style="font-size:0.62rem;padding:1px 6px;">'+esc(c.company)+'</span>':'')+(c.fund?'<span class="client-card-tag client-card-tag-fund" style="font-size:0.62rem;padding:1px 6px;">'+esc(c.fund)+'</span>':'')+'</div>' : '')+
        formatKqDisplay(c.keyQuestions)+
        '<div class="temp-card-row"><span class="temp-card-note">'+esc(c.note||'')+'</span></div>'+
        '<div style="border-top:1px solid var(--border-light);padding-top:4px;margin-top:2px;">'+
          '<div style="display:flex;justify-content:space-between;align-items:center;">'+
            '<span style="font-size:0.62rem;color:var(--text-light);font-weight:600;">'+(fuCount>0?fuCount+'条':'')+'</span>'+
            '<button class="temp-tbl-followup-btn" data-idx="'+i+'" style="font-size:0.7rem;width:22px;height:22px;border:none;background:transparent;color:var(--accent-wechat);cursor:pointer;font-weight:700;line-height:1;">+</button>'+
          '</div>'+
          (fuParts.length>0?'<div style="margin-top:2px;">'+fuParts.join('')+'</div>':'')+
          '<div class="temp-followup-inline-form" data-idx="'+i+'" style="display:none;margin-top:4px;">'+
            '<textarea class="temp-followup-input" placeholder="新增跟进记录..." style="width:100%;min-height:36px;padding:4px 6px;font-size:0.7rem;resize:vertical;border:1px solid var(--card-border);border-radius:4px;background:var(--input-bg);color:var(--text-main);font-family:inherit;box-sizing:border-box;"></textarea>'+
            '<div style="display:flex;justify-content:flex-end;gap:4px;margin-top:3px;">'+
              '<button class="temp-followup-save" data-idx="'+i+'" style="font-size:0.62rem;padding:2px 8px;background:var(--accent-btn);color:#fff;border:none;border-radius:3px;font-weight:600;cursor:pointer;">保存</button>'+
              '<button class="temp-followup-cancel" style="font-size:0.62rem;padding:2px 8px;background:var(--btn-bg);color:var(--text-soft);border:1px solid var(--card-border);border-radius:3px;font-weight:600;cursor:pointer;">取消</button>'+
            '</div>'+
          '</div>'+
        '</div>'+
      '</div>';
    }
    cardList.innerHTML=cardHtml;
    var allDelBtns=cardList.querySelectorAll('.temp-tbl-del');
    var allEditBtns=cardList.querySelectorAll('.temp-tbl-edit');
    var allConvertBtns=cardList.querySelectorAll('.temp-tbl-convert');
    allDelBtns.forEach(function(b){
      b.onclick=async function(){
        var idx=parseInt(this.dataset.idx);
        var a=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
        // 按日期重新排序后找到正确位置
        a.sort(function(x,y){ return (y.date||'').localeCompare(x.date||'')||(y.time||'').localeCompare(x.time||''); });
        if(idx<0||idx>=a.length) return;
        if(!confirm('删除 '+a[idx].name+' ?')) return;
        a.splice(idx,1);
        localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(a));
        renderTempFullTable();
        renderTempClientList();
        await syncOp('setTempClients',{tempClients:a});
      };
    });
    allEditBtns.forEach(function(b){
      b.onclick=function(){
        var key=this.dataset.key;
        var a=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
        var idx=-1;
        for(var ai=0;ai<a.length;ai++){ if((a[ai].name+'|'+a[ai].phone)===key){ idx=ai; break; } }
        if(idx<0) return;
        document.getElementById('tempFullModal').classList.remove('active');
        tempEditClient(idx);
      };
    });
    allConvertBtns.forEach(function(b){
      b.onclick=async function(){
        var idx=parseInt(this.dataset.idx);
        var a=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
        a.sort(function(x,y){ return (y.date||'').localeCompare(x.date||'')||(y.time||'').localeCompare(x.time||''); });
        if(idx<0||idx>=a.length) return;
        var c=a[idx];
        document.getElementById('custName').value=c.name;
        document.getElementById('custPhone').value=c.phone;
        document.getElementById('custNote').value=c.note||'';
        document.getElementById('custCompany').value=c.company||'';
        document.getElementById('custFund').value=c.fund||'';
        a.splice(idx,1);
        localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(a));
        renderTempFullTable();
        renderTempClientList();
        await syncOp('setTempClients',{tempClients:a});
        document.getElementById('custName').focus();
        var card=document.getElementById('custName').closest('.card');
        if(card){ card.style.transform='scale(1.02)'; card.style.transition='all 0.3s'; setTimeout(function(){ card.style.transform='none'; },500); }
      };
    });
    // Export single temp client
    cardList.querySelectorAll('.temp-tbl-export').forEach(function(b){
      b.onclick=async function(){
        var idx=parseInt(this.dataset.idx);
        var a=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
        a.sort(function(x,y){ return (y.date||'').localeCompare(x.date||'')||(y.time||'').localeCompare(x.time||''); });
        if(idx<0||idx>=a.length) return;
        var c=a[idx];
        var savedUrl=(localStorage.getItem('webhook_url')||'').trim();
        if(!savedUrl){
          alert('请先在主菜单 → 导出数据 中配置企业微信 Webhook URL');
          return;
        }
        b.disabled=true;
        var origHTML=b.innerHTML;
        b.innerHTML='...';
        try{
          var r=await fetch('/api/export',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({type:'temp_single_client',webhookUrl:savedUrl,client:c})
          });
          if(r.ok){
            alert('客户已成功导出到企业微信！');
          }else{
            var err=await r.json();
            alert('导出失败: ' + (err.error || r.statusText));
          }
        }catch(errVal){
          alert('网络错误: ' + errVal.message);
        }
        b.disabled=false;
        b.innerHTML=origHTML;
      };
    });
    // Follow-up buttons
    cardList.querySelectorAll('.temp-tbl-followup-btn').forEach(function(b){
      b.onclick=function(){
        var form=cardList.querySelector('.temp-followup-inline-form[data-idx="'+this.dataset.idx+'"]');
        if(form) form.style.display=form.style.display==='none'?'block':'none';
        var ta=form&&form.querySelector('textarea');
        if(ta) setTimeout(function(){ ta.focus(); },100);
      };
    });
    cardList.querySelectorAll('.temp-followup-save').forEach(function(b){
      b.onclick=async function(){
        var idx=parseInt(this.dataset.idx);
        var form=cardList.querySelector('.temp-followup-inline-form[data-idx="'+idx+'"]');
        var ta=form&&form.querySelector('textarea');
        var content=(ta&&ta.value.trim())||'';
        if(!content) return;
        var a=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
        if(idx<0||idx>=a.length) return;
        if(!a[idx].followUps) a[idx].followUps=[];
        var now=new Date();
        var dateStr=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
        var timeStr=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
        a[idx].followUps.push({date:dateStr,time:timeStr,content:content});
        localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(a));
        renderTempFullTable();
        await syncOp('setTempClients',{tempClients:a});
      };
    });
    cardList.querySelectorAll('.temp-followup-cancel').forEach(function(b){
      b.onclick=function(){
        var form=this.closest('.temp-followup-inline-form');
        if(form){ form.style.display='none'; form.querySelector('textarea').value=''; }
      };
    });
  }

  function openTempFullTable(){
    renderTempFullTable();
    document.getElementById('tempFullModal').classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  function closeTempFullTable(){
    document.getElementById('tempFullModal').classList.remove('active');
    document.body.style.overflow = '';
  }

  async function addTodoItem(){
    const input=document.getElementById('todoInput'),text=input.value.trim();
    if(!text)return;const remind=document.getElementById('todoRemindTime').value;
    const isToday = todoActiveTab === 'today';
    const todo={text,time:getCurrentTime(),date:getTodayStr(),remind:remind||'',type:isToday?'today':'tomorrow'};
    const storageKey = isToday ? TODAY_TODO_K : TOMORROW_TODO_K;
    const t=loadTodos(storageKey);t.push(todo);saveTodos(storageKey,t);input.value='';document.getElementById('todoRemindTime').value='';renderTodos();
    pushTodoLog(todo,getTodayStr());
    await syncOp(isToday?'setTodayTodos':'setTomorrowTodos',{todos:t});
  }

  // ==================== 账号认证 ====================
  const AUTH_TOKEN_K='auth_token',AUTH_USER_K='auth_user';
  function showAuthGate(){
    document.body.classList.add('page-auth');
    document.body.classList.remove('page-hidden');
    document.getElementById('authError').innerText='';
    document.getElementById('authUsername').value='';
    document.getElementById('authPassword').value='';
    document.getElementById('authRegUsername').value='';
    document.getElementById('authRegPassword').value='';
    document.getElementById('authRegPassword2').value='';
    document.getElementById('authFormLogin').style.display='flex';
    document.getElementById('authFormRegister').style.display='none';
    setTimeout(function(){document.getElementById('authUsername').focus();},100);
  }
  function hideAuthGate(){
    document.body.classList.remove('page-auth');
  }
  function setAuthError(msg){
    document.getElementById('authError').innerText=msg;
    setTimeout(function(){document.getElementById('authError').innerText='';},5000);
  }
  async function doLogin(username,password){
    if(!username||!password){setAuthError('请输入账号和密码');return;}
    var btn=document.getElementById('authLoginBtn');
    btn.disabled=true;btn.innerText='登录中...';
    try{
      var r=await fetch('/api/auth/login',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:username,password:password})
      });
      var d=await r.json();
      if(r.ok&&d.access_token){
        localStorage.setItem(AUTH_TOKEN_K,d.access_token);
        localStorage.setItem(AUTH_USER_K,username);
        hideAuthGate();
        localStorage.setItem(UNLOCK_TS_K,Date.now());
        setLocked(false);
        showJournalShell();
        initWp();
        initSync();
      }else{
        setAuthError(d.error||'登录失败');
      }
    }catch(e){setAuthError('网络错误，请重试');}
    btn.disabled=false;btn.innerText='登录';
  }
  async function doRegister(username,password,password2){
    if(!username||!password){setAuthError('请输入账号和密码');return;}
    if(password.length<4){setAuthError('密码至少4位');return;}
    if(password!==password2){setAuthError('两次密码不一致');return;}
    var btn=document.getElementById('authRegisterBtn');
    btn.disabled=true;btn.innerText='创建中...';
    try{
      var r=await fetch('/api/auth/setup',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:username,password:password})
      });
      var d=await r.json();
      if(r.ok&&d.access_token){
        localStorage.setItem(AUTH_TOKEN_K,d.access_token);
        localStorage.setItem(AUTH_USER_K,username);
        hideAuthGate();
        localStorage.setItem(UNLOCK_TS_K,Date.now());
        setLocked(false);
        showJournalShell();
        initWp();
        initSync();
      }else{
        setAuthError(d.error||'创建失败');
      }
    }catch(e){setAuthError('网络错误，请重试');}
    btn.disabled=false;btn.innerText='创建账号';
  }
  function doLogout(){
    var token=localStorage.getItem(AUTH_TOKEN_K);
    if(token){fetch('/api/auth/logout',{method:'POST',headers:{'Authorization':'Bearer '+token}}).catch(function(){});}
    localStorage.removeItem(AUTH_TOKEN_K);
    localStorage.removeItem(AUTH_USER_K);
    localStorage.removeItem('unlock_ts');
    document.body.className='page-auth';
    setTimeout(function(){document.getElementById('authUsername').focus();},100);
  }
  async function checkAuth(){
    var token=localStorage.getItem(AUTH_TOKEN_K);
    if(!token)return false;
    try{
      var r=await fetch('/api/auth/user',{headers:{'Authorization':'Bearer '+token}});
      return r.ok;
    }catch(e){return false;}
  }

  // ==================== 日记 ====================
  const JOURNAL_K='journal_v1', MOODS=['','开心','平静','疲惫','焦虑','兴奋','难过','感恩'], WEATHERS=['','晴','多云','阴','雨','雪','风'];
  function loadJournalMap(){try{return JSON.parse(localStorage.getItem(JOURNAL_K))||{};}catch(e){return{};}}
  function saveJournalMap(m){localStorage.setItem(JOURNAL_K,JSON.stringify(m));}
  function getJournalEntries(date){var m=loadJournalMap();return m[date]||[];}
  function setJournalEntries(date,entries){var m=loadJournalMap();m[date]=entries;saveJournalMap(m);}
  function journalSaveOp(date){var entries=getJournalEntries(date);syncOp('setJournal',{date:date,entries:entries});}
  function journalGetMoodLabel(v){return v||'心情';}
  function journalGetWeatherLabel(v){return v||'天气';}

  function showWorkShell(){
    document.body.classList.remove('page-journal','page-auth','page-hidden');
    var app=document.querySelector('.app-shell');if(app)app.style.display='flex';
    var js=document.getElementById('journalShell');if(js)js.style.display='none';
    initPasteModule();
    refreshAll();
  }
  function showJournalShell(){
    document.body.classList.add('page-journal');
    document.body.classList.remove('page-auth','page-hidden');
    var app=document.querySelector('.app-shell');if(app)app.style.display='none';
    var js=document.getElementById('journalShell');if(js)js.style.display='flex';
    initJournal();
    loadJournalFromCloud(getTodayStr());
  }

  async function loadJournalFromCloud(date){
    try{
      var r=await fetch('/api/data?date='+date);
      if(r.ok){
        var d=await r.json();
        if(d.journal&&d.journal.length>0){setJournalEntries(date,d.journal);}
      }
    }catch(e){}
    renderJournalMain(date);
  }

  function renderJournalMain(date){
    var main=document.getElementById('journalMain');
    if(!main)return;
    var entries=getJournalEntries(date);
    if(!entries.length){
      main.innerHTML='<div class="journal-empty">还没有今天的记录<br>点击「新建记录」开始写日记吧</div>';
      return;
    }
    var h='';
    for(var i=entries.length-1;i>=0;i--){
      h+=renderJournalCard(entries[i],i);
    }
    main.innerHTML=h;
    // bind delete handlers
    var dels=main.querySelectorAll('.journal-act-del');
    for(var j=0;j<dels.length;j++){
      (function(idx){dels[j].onclick=function(){deleteJournalEntry(date,idx);};})(parseInt(dels[j].getAttribute('data-idx')));
    }
  }

  function renderJournalCard(entry,idx){
    var mood=entry.mood||'', weather=entry.weather||'', loc=entry.location||'';
    var meta='';
    if(mood)meta+='<span class="journal-meta-tag">'+mood+'</span>';
    if(weather)meta+='<span class="journal-meta-tag">'+weather+'</span>';
    if(loc)meta+='<span class="journal-meta-tag">'+loc+'</span>';
    meta+='<span class="journal-meta-tag" style="opacity:0.6">'+formatTs(entry.createdAt||'')+'</span>';
    var media='';
    if(entry.media&&entry.media.length>0){
      media='<div class="journal-media-row">';
      for(var j=0;j<entry.media.length;j++){
        media+='<img class="journal-media-thumb" src="'+entry.media[j].url+'" loading="lazy">';
      }
      media+='</div>';
    }
    var h='<div class="journal-card">';
    h+='<div class="journal-meta">'+meta+'</div>';
    h+='<div class="journal-content">'+(entry.content||'')+'</div>';
    h+=media;
    h+='<div class="journal-actions">';
    h+='<button class="journal-act-btn journal-act-del" data-idx="'+idx+'">删除</button>';
    h+='</div>';
    h+='</div>';
    return h;
  }

  function deleteJournalEntry(date,idx){
    if(!confirm('确定删除这条记录？'))return;
    var entries=getJournalEntries(date);
    entries.splice(idx,1);
    setJournalEntries(date,entries);
    journalSaveOp(date);
    renderJournalMain(date);
  }

  function openNewRecord(){
    var main=document.getElementById('journalMain');
    if(!main)return;
    var ed='<div class="journal-editor" id="journalEditor">';
    ed+='<textarea id="journalEditorContent" placeholder="今天发生了什么..."></textarea>';
    ed+='<div class="journal-editor-row">';
    ed+='<select id="journalEditorMood">';
    for(var i=0;i<MOODS.length;i++){ed+='<option value="'+(i===0?'':MOODS[i])+'">'+(i===0?'选择心情':MOODS[i])+'</option>';}
    ed+='</select>';
    ed+='<select id="journalEditorWeather">';
    for(var j=0;j<WEATHERS.length;j++){ed+='<option value="'+(j===0?'':WEATHERS[j])+'">'+(j===0?'选择天气':WEATHERS[j])+'</option>';}
    ed+='</select>';
    ed+='<input type="text" id="journalEditorLoc" placeholder="位置" style="padding:6px 10px;border-radius:14px;border:1px solid rgba(0,0,0,0.1);background:rgba(255,255,255,0.6);font-size:0.85rem;outline:none;width:120px;">';
    ed+='<button class="topbar-btn" id="journalEditorSave">保存</button>';
    ed+='<button class="journal-act-btn" id="journalEditorCancel">取消</button>';
    ed+='</div></div>';
    main.innerHTML=ed+main.innerHTML;
    document.getElementById('journalEditorContent').focus();
    document.getElementById('journalEditorSave').onclick=function(){saveNewRecord();};
    document.getElementById('journalEditorCancel').onclick=function(){
      var edEl=document.getElementById('journalEditor');if(edEl)edEl.remove();
    };
  }

  function saveNewRecord(){
    var content=document.getElementById('journalEditorContent').value.trim();
    if(!content)return;
    var mood=document.getElementById('journalEditorMood').value;
    var weather=document.getElementById('journalEditorWeather').value;
    var loc=document.getElementById('journalEditorLoc').value.trim();
    var date=getTodayStr();
    var entries=getJournalEntries(date);
    entries.push({
      id:Date.now().toString(36)+Math.random().toString(36).slice(2),
      mood:mood, weather:weather, location:loc,
      content:content, media:[], tags:[], favorite:false,
      createdAt:new Date().toISOString()
    });
    setJournalEntries(date,entries);
    journalSaveOp(date);
    renderJournalMain(date);
  }

  function renderJournalCalendar(offset){
    var main=document.getElementById('journalMain');
    if(!main)return;
    if(typeof offset==='undefined')offset=0;
    if(typeof _journalCalOffset==='undefined')_journalCalOffset=0;
    if(typeof offset==='number')_journalCalOffset+=offset;
    var now=new Date();
    var y=now.getFullYear(), m=now.getMonth()+1+_journalCalOffset;
    while(m>12){y++;m-=12;}while(m<1){y--;m+=12;}
    var today=getTodayStr();
    var mn=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    var fd=new Date(y,m-1,1), si=(fd.getDay()+6)%7;
    var dim=new Date(y,m,0).getDate();
    // 收集当月有日记的日期
    var hasEntry={};
    var jm=loadJournalMap();
    for(var d=1;d<=dim;d++){
      var ds=y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      var entries=jm[ds]||[];
      if(entries.length>0)hasEntry[ds]=entries.length;
    }
    var wd=['一','二','三','四','五','六','日'];
    var h='<div class="journal-card"><div class="cal-header">';
    h+='<button class="cal-nav" id="calPrev">←</button>';
    h+='<span class="cal-title">'+y+'年 '+mn[m-1]+'</span>';
    h+='<button class="cal-nav" id="calNext">→</button>';
    h+='</div>';
    h+='<div class="cal-grid">';
    for(var i=0;i<7;i++)h+='<div class="cal-wd">'+wd[i]+'</div>';
    for(var j=0;j<si;j++)h+='<div class="cal-cell cal-empty"></div>';
    for(var d=1;d<=dim;d++){
      var ds=y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      var isToday=ds===today;
      var isWeekend=(si+d-1)%7>=5;
      var n=hasEntry[ds]||0;
      var cls='cal-cell'+(isToday?' cal-today':'')+(isWeekend?' cal-weekend':'')+(n>0?' cal-has':'');
      h+='<div class="'+cls+'" data-ds="'+ds+'">';
      h+='<span class="cal-dnum">'+d+'</span>';
      if(n>0)h+='<span class="cal-dot"></span>';
      h+='</div>';
    }
    h+='</div></div>';
    main.innerHTML=h;
    // 月份导航
    document.getElementById('calPrev').onclick=function(){renderJournalCalendar(-1);};
    document.getElementById('calNext').onclick=function(){renderJournalCalendar(1);};
    // 点击日期
    var cells=main.querySelectorAll('.cal-cell[data-ds]');
    for(var k=0;k<cells.length;k++){
      cells[k].addEventListener('click',function(){
        var ds=this.getAttribute('data-ds');
        var items=document.querySelectorAll('.sidebar-item');
        for(var x=0;x<items.length;x++)items[x].classList.remove('active');
        var homeItem=document.querySelector('.sidebar-item[data-page="home"]');
        if(homeItem)homeItem.classList.add('active');
        renderJournalMain(ds);
      });
    }
  }
  var _journalCalOffset=0;

  function renderJournalSettings(){
    var main=document.getElementById('journalMain');
    if(!main)return;
    var h='<div class="journal-card">';
    h+='<div class="section-title">设置</div>';
    h+='<div style="display:flex;flex-direction:column;gap:12px;margin-top:8px">';
    h+='<div style="padding:10px 0;color:var(--text-soft)">账号：'+ (localStorage.getItem(AUTH_USER_K)||'') + '</div>';
    h+='<button class="journal-act-btn" style="color:#e74c3c;border-color:#e74c3c;width:fit-content" id="journalSettingsLogout">退出登录</button>';
    h+='</div></div>';
    main.innerHTML=h;
    var btn=document.getElementById('journalSettingsLogout');
    if(btn)btn.addEventListener('click',function(){if(confirm('确定要退出登录吗？'))doLogout();});
  }

  function initJournal(){
    // 侧边栏导航
    var items=document.querySelectorAll('.sidebar-item');
    for(var i=0;i<items.length;i++){
      items[i].addEventListener('click',function(){
        var page=this.getAttribute('data-page');
        // update active state
        for(var k=0;k<items.length;k++)items[k].classList.remove('active');
        this.classList.add('active');
        if(page==='home'){showJournalShell();}
        else if(page==='calendar'){renderJournalCalendar();}
        else if(page==='settings'){renderJournalSettings();}
      });
    }
    // 新建记录按钮
    var nb=document.getElementById('journalNewBtn');
    if(nb)nb.addEventListener('click',function(){openNewRecord();});
    // 锁屏按钮
    var jlb=document.getElementById('journalLockBtn');
    if(jlb)jlb.addEventListener('click',function(){localStorage.removeItem(UNLOCK_TS_K);setLocked(true);pi.value='';pie.innerText='';});
    // 搜索
    var sj=document.getElementById('journalSearch');
    if(sj)sj.addEventListener('input',function(){
      var q=this.value.trim().toLowerCase();
      var cards=document.querySelectorAll('.journal-card');
      for(var c=0;c<cards.length;c++){
        var text=cards[c].textContent.toLowerCase();
        cards[c].style.display=q?((text.indexOf(q)>=0)?'':'none'):'';
      }
    });
  }

  // ==================== 壁纸 ====================
  const FW=["https://t.alcy.cc/","https://t.alcy.cc/mp/","https://api.dujin.org/pic/yuanshen/","https://api.paugram.com/wallpaper/","https://www.loliapi.com/acg/pe/","https://www.loliapi.com/acg/","https://t.mwm.moe/mp"];
  function getWpCache(){try{const c=JSON.parse(localStorage.getItem(WALLPAPER_K));if(c&&c.date===getTodayStr()&&c.url)return c;}catch(e){}return null;}
  function saveWpCache(url){localStorage.setItem(WALLPAPER_K,JSON.stringify({date:getTodayStr(),url}));}
  function rndWp(){return FW[Math.floor(Math.random()*FW.length)];}
  async function fetchWp(){
    try{const r=await fetch("/api/wallpaper");if(r.ok){const d=await r.json();if(d.url)return d.url;}}catch(e){}
    return rndWp();
  }
  function applyWp(url){
    if(!url)return;const img=new Image();
    img.onload=()=>{document.documentElement.style.setProperty('--wallpaper-url','url('+url+')');const pw=document.getElementById('privacyWallpaper');if(pw)pw.style.backgroundImage='url('+url+')';};
    img.onerror=()=>{const fu=rndWp();const fi=new Image();fi.onload=()=>{document.documentElement.style.setProperty('--wallpaper-url','url('+fu+')');const pw=document.getElementById('privacyWallpaper');if(pw)pw.style.backgroundImage='url('+fu+')';};fi.src=fu;};
    img.src=url;
  }
  async function loadWp(force=false){
    if(!force){const c=getWpCache();if(c){applyWp(c.url);}}
    let u=null;try{u=await fetchWp();}catch(e){}
    if(!u){u=rndWp();if(!u){const c=getWpCache();if(c){applyWp(c.url);return;}}}
    if(u){applyWp(u);saveWpCache(u);}
  }
  function initWp(){
    setTimeout(()=>loadWp(false),1000);
    setInterval(()=>{loadWp(true);},3600000);
    function smr(){const n=new Date(),mn=new Date(n);mn.setHours(24,0,0,0);setTimeout(()=>{if(!document.body.classList.contains('page-hidden'))loadWp(true);smr();},mn-n+60000);}smr();
  }

  // ==================== 学习 ====================
  const loadLearns=()=>{try{return JSON.parse(localStorage.getItem(LEARN_K))||[];}catch(e){return[];}};
  const saveLearns=(a)=>localStorage.setItem(LEARN_K,JSON.stringify(a));
  
  function getSourceTypeColor(type) {
    switch(type) {
      case '微信聊天':
        return 'background:rgba(255,255,255,0.4); color:#5a6a7e;';
      case '电话录音':
        return 'background:rgba(74,108,247,0.1); color:#4a6cf7;';
      case '客户案例':
        return 'background:rgba(245,124,0,0.1); color:#f57c00;';
      case '企业资料':
        return 'background:rgba(231,76,60,0.1); color:#e74c3c;';
      default:
        return 'background:rgba(120,120,120,0.1); color:#7f8c8d;';
    }
  }

  function normalizeLearnItem(l) {
    if (!l) return null;
    if (typeof l === 'string') {
      return {
        title: '自主学习',
        summary: l.length > 20 ? l.slice(0, 17) + '...' : l,
        content: l,
        tags: ['学习'],
        source_type: '自定义',
        show: true
      };
    }
    if (l.text && !l.content) {
      return {
        title: l.title || '自主学习',
        summary: l.summary || (l.text.length > 20 ? l.text.slice(0, 17) + '...' : l.text),
        content: l.text,
        tags: l.tags || ['学习'],
        source_type: l.source_type || '自定义',
        show: l.show !== undefined ? l.show : true
      };
    }
    return {
      title: l.title || '自主学习',
      summary: l.summary || '',
      content: l.content || l.text || '',
      tags: Array.isArray(l.tags) ? l.tags : ['学习'],
      source_type: l.source_type || '自定义',
      show: l.show !== undefined ? l.show : true
    };
  }

  function renderLearnList(){
    const ls=loadLearns().map(normalizeLearnItem).filter(Boolean);
    document.getElementById('learnList').innerHTML=ls.length===0?'<div style="font-size:0.75rem;color:var(--text-light);padding:8px;text-align:center;">暂无学习</div>':ls.map((l,i)=>{
      return '<div class="script-item" style="display:flex; flex-direction:column; gap:6px; padding:10px; align-items:stretch; border:1px solid var(--card-border); background:var(--btn-bg); border-radius:6px; margin-bottom:8px;">' +
        '<div style="display:flex; justify-content:space-between; align-items:center;">' +
          '<span style="font-size:0.65rem; padding:2px 6px; border-radius:4px; font-weight:700; ' + getSourceTypeColor(l.source_type) + '">' + esc(l.source_type) + '</span>' +
          '<div style="display:flex; gap:8px; align-items:center;">' +
            '<label style="font-size:0.65rem; color:var(--text-soft); display:flex; align-items:center; gap:3px; cursor:pointer;">' +
              '<input type="checkbox" ' + (l.show ? 'checked' : '') + ' data-li="' + i + '"> 锁屏' +
            '</label>' +
            '<button class="del-icon" data-li="' + i + '" style="border:none; background:none; color:var(--text-light); font-size:1.1rem; cursor:pointer; padding:0 4px; line-height:1;">×</button>' +
          '</div>' +
        '</div>' +
        '<div style="font-weight:800; font-size:0.8rem; color:var(--text-main);">' + esc(l.title) + '</div>' +
        '<div style="font-size:0.7rem; color:var(--text-soft); font-weight:400; line-height:1.4; word-break:break-all; white-space:pre-wrap;">' + esc(l.content) + '</div>' +
        (l.tags && l.tags.length > 0 ? 
          '<div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:2px;">' +
            l.tags.map(t => '<span style="font-size:0.55rem; color:var(--accent-wechat); background:var(--accent-wechat-bg); padding:1px 5px; border-radius:3px;">#' + esc(t) + '</span>').join('') +
          '</div>' : '') +
      '</div>';
    }).join('');

    document.querySelectorAll('#learnList .del-icon').forEach(b=>b.addEventListener('click',async e=>{
      const i=parseInt(b.dataset.li);const a=loadLearns();a.splice(i,1);saveLearns(a);renderLearnList();renderLockLearns();
      await syncOp('setLearns',{learns:a});
    }));

    document.querySelectorAll('#learnList input[type=checkbox]').forEach(cb=>cb.addEventListener('change',async e=>{
      const i=parseInt(cb.dataset.li);const a=loadLearns();a[i].show=cb.checked;saveLearns(a);renderLearnList();renderLockLearns();
      await syncOp('setLearns',{learns:a});
    }));
  }

  function renderLockLearns(){
    const ls=loadLearns().map(normalizeLearnItem).filter(Boolean);
    const container=document.getElementById('learnContainer');
    const visible=ls.filter(l=>l.show);
    if(visible.length===0){container.innerHTML='';return;}
    container.innerHTML=visible.map((l,i)=>{
      return '<div class="learn-module" data-li="' + i + '">' +
        '<div style="font-weight:900; font-size:0.85rem; border-bottom:1px solid var(--border-light); padding-bottom:6px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">' +
          '<span>' + esc(l.title) + '</span>' +
          '<span style="font-size:0.6rem; ' + getSourceTypeColor(l.source_type) + ' padding:2px 6px; border-radius:3px; font-weight:700;">' + esc(l.source_type) + '</span>' +
        '</div>' +
        '<div style="font-size:0.75rem; line-height:1.5; margin-bottom:6px; opacity:0.95;">' + esc(l.content) + '</div>' +
        (l.tags && l.tags.length > 0 ? 
          '<div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:4px;">' +
            l.tags.map(t => '<span style="font-size:0.6rem; color:#7b9ff5; background:rgba(74,108,247,0.1); padding:1px 4px; border-radius:3px;">#' + esc(t) + '</span>').join('') +
          '</div>' : '') +
      '</div>';
    }).join('');
    container.querySelectorAll('.learn-module').forEach(el=>makeDraggable(el));
  }

  function initLearnFeature(){
    renderLockLearns();
    
    const providerSel = document.getElementById('aiProviderSelect');
    const apiBaseInp = document.getElementById('aiApiBaseInput');
    const modelInp = document.getElementById('aiModelInput');
    const apiKeyInp = document.getElementById('aiApiKeyInput');

    function updateAiPlaceholders() {
      const p = providerSel.value;
      if (p === 'deepseek') {
        apiBaseInp.placeholder = 'https://api.deepseek.com/v1 (默认)';
        modelInp.placeholder = 'deepseek-chat (V4 Pro 默认)';
      } else if (p === 'gemini') {
        apiBaseInp.placeholder = 'https://generativelanguage.googleapis.com/v1beta/openai (默认)';
        modelInp.placeholder = 'gemini-2.5-flash (默认)';
      } else {
        apiBaseInp.placeholder = 'https://api.openai.com/v1 (默认)';
        modelInp.placeholder = 'gpt-4o (默认)';
      }
    }

    providerSel.addEventListener('change', updateAiPlaceholders);

    document.getElementById('learnBtn').addEventListener('click',()=>{
      renderLearnList();
      refreshPasteList();
      document.getElementById('newLearnInput').value='';
      document.getElementById('learnShowCheck').checked=true;
      
      providerSel.value = localStorage.getItem('ai_provider') || 'gemini';
      apiKeyInp.value = localStorage.getItem('ai_api_key') || localStorage.getItem('deepseek_api_key') || '';
      apiBaseInp.value = localStorage.getItem('ai_api_base') || '';
      modelInp.value = localStorage.getItem('ai_model') || '';
      updateAiPlaceholders();

      document.getElementById('learnModal').classList.add('active');
    });

    document.getElementById('closeLearnModalBtn').addEventListener('click',()=>document.getElementById('learnModal').classList.remove('active'));
    document.getElementById('learnModal').addEventListener('click',e=>{if(e.target===document.getElementById('learnModal'))document.getElementById('learnModal').classList.remove('active');});

    document.getElementById('saveAiConfigBtn').addEventListener('click',async ()=>{
      const provider = providerSel.value;
      const apiKey = apiKeyInp.value.trim();
      const apiBase = apiBaseInp.value.trim();
      const model = modelInp.value.trim();

      localStorage.setItem('ai_provider', provider);
      localStorage.setItem('ai_api_key', apiKey);
      localStorage.setItem('ai_api_base', apiBase);
      localStorage.setItem('ai_model', model);
      localStorage.setItem('deepseek_api_key', apiKey); // Backwards compatibility fallback

      await syncOp('setAiConfig', {
        aiProvider: provider,
        aiApiKey: apiKey,
        aiApiBase: apiBase,
        aiModel: model
      });
      alert('AI 大模型配置已保存到本地及云端！');
    });

    document.getElementById('addLearnBtn').addEventListener('click',async ()=>{
      const content=document.getElementById('newLearnInput').value.trim();
      const source_type=document.getElementById('learnSourceSelect').value;
      if(!content)return;
      const show=document.getElementById('learnShowCheck').checked;
      
      const newItem={
        title: '手动登记',
        summary: content.length > 25 ? content.slice(0, 22) + '...' : content,
        content: content,
        tags: ['学习'],
        source_type: source_type,
        show: show
      };

      const a=loadLearns();
      a.unshift(newItem);
      saveLearns(a);
      document.getElementById('newLearnInput').value='';
      await syncOp('setLearns',{learns:a});
      renderLearnList();renderLockLearns();
    });

    document.getElementById('aiLearnBtn').addEventListener('click',async ()=>{
      const content=document.getElementById('newLearnInput').value.trim();
      const source_type=document.getElementById('learnSourceSelect').value;
      if(!content){
        alert('请先在输入框中粘贴/输入需要提炼的原始内容！');
        return;
      }

      const btn=document.getElementById('aiLearnBtn');
      const originalText=btn.innerHTML;
      btn.innerHTML='AI 提炼中...';
      btn.disabled=true;

      try{
        const apiKey = localStorage.getItem('ai_api_key') || localStorage.getItem('deepseek_api_key') || '';
        const r=await fetch('/api/learning/save',{
          method:'POST',
          headers:{
            'Content-Type':'application/json'
          },
          body:JSON.stringify({
            source_type:source_type,
            content:content,
            apiKey:apiKey
          })
        });

        if(!r.ok){
          const errData=await r.json();
          throw new Error(errData.error || ('HTTP '+r.status));
        }

        const res=await r.json();
        if(res.success && res.data){
          const l=res.data;
          const show=document.getElementById('learnShowCheck').checked;
          const newItem={
            title:l.title,
            summary:l.summary,
            content:l.content,
            tags:l.tags,
            source_type:l.source_type,
            show:show
          };

          const a=loadLearns();
          a.unshift(newItem);
          saveLearns(a);
          document.getElementById('newLearnInput').value='';
          await syncOp('setLearns',{learns:a});
          renderLearnList();renderLockLearns();
          
          if(res.isMock){
            alert('🎉 （模拟AI）提炼并保存成功！由于未设置真实 DeepSeek API Key，已使用本地模板完成归纳。在 API 配置中填入密钥可享受真实 AI 提炼。');
          }else{
            alert('🎉 AI 提炼并保存成功！');
          }
        }
      }catch(err){
        console.error(err);
        alert('AI 提炼失败: '+err.message);
      }finally{
        btn.innerHTML=originalText;
        btn.disabled=false;
      }
    });

  }

  // ==================== 话术 ====================
  const loadScripts=()=>{try{return JSON.parse(localStorage.getItem(SCRIPTS_K))||[];}catch(e){return[];}};
  const saveScripts=(a)=>localStorage.setItem(SCRIPTS_K,JSON.stringify(a));
  function renderScriptList(){
    const ss=loadScripts();
    document.getElementById('scriptList').innerHTML=ss.length===0?'<div style="font-size:0.75rem;color:var(--text-light);padding:8px;text-align:center;">暂无话术</div>':ss.map((s,i)=>'<div class="script-item" data-si="'+i+'"><span class="script-item-text">'+esc(s)+'</span><div style="display:flex;gap:4px;align-items:center;flex-shrink:0;"><button class="edit-icon" data-si="'+i+'" title="编辑">编</button><button class="del-icon" data-si="'+i+'">×</button></div></div>').join('');
    document.querySelectorAll('#scriptList .del-icon').forEach(b=>b.addEventListener('click',async e=>{
      const i=parseInt(b.dataset.si);const a=loadScripts();a.splice(i,1);saveScripts(a);renderScriptList();renderLockScripts();
      await syncOp('setScripts',{scripts:a});
    }));
    document.querySelectorAll('#scriptList .edit-icon').forEach(b=>b.addEventListener('click',e=>{
      const i=parseInt(b.dataset.si);const a=loadScripts();const old=a[i];const item=document.querySelector('#scriptList .script-item[data-si="'+i+'"]');
      item.innerHTML='<input class="input-simple" id="editScriptInput_'+i+'" value="'+esc(old).replace(/"/g,'&quot;')+'" style="flex:1;font-size:0.75rem;padding:6px 10px;min-width:0;" autocomplete="off"><div style="display:flex;gap:4px;flex-shrink:0;"><button class="btn-add" id="saveScriptEdit_'+i+'" style="font-size:0.7rem;padding:6px 12px;">保存</button><button class="del-icon" id="cancelScriptEdit_'+i+'" style="color:var(--text-soft);">取消</button></div>';
      document.getElementById('saveScriptEdit_'+i).addEventListener('click',async ()=>{
        const v=document.getElementById('editScriptInput_'+i).value.trim();if(!v)return;
        a[i]=v;saveScripts(a);renderScriptList();renderLockScripts();
        await syncOp('setScripts',{scripts:a});
      });
      document.getElementById('cancelScriptEdit_'+i).addEventListener('click',()=>renderScriptList());
      document.getElementById('editScriptInput_'+i).addEventListener('keypress',e=>{if(e.key==='Enter')document.getElementById('saveScriptEdit_'+i).click();});
      document.getElementById('editScriptInput_'+i).focus();
    }));
  }
  function makeDraggable(el){
    let active=false,sx=0,sy=0,tx=0,ty=0;
    el.addEventListener('mousedown',e=>{active=true;sx=e.clientX-tx;sy=e.clientY-ty;el.style.cursor='grabbing';e.preventDefault();});
    el.addEventListener('touchstart',e=>{active=true;sx=e.touches[0].clientX-tx;sy=e.touches[0].clientY-ty;el.style.cursor='grabbing';},{passive:false});
    document.addEventListener('mousemove',e=>{if(!active)return;tx=e.clientX-sx;ty=e.clientY-sy;el.style.transform='translate('+tx+'px,'+ty+'px)';});
    document.addEventListener('touchmove',e=>{if(!active)return;tx=e.touches[0].clientX-sx;ty=e.touches[0].clientY-sy;el.style.transform='translate('+tx+'px,'+ty+'px)';},{passive:false});
    document.addEventListener('mouseup',()=>{active=false;el.style.cursor='grab';});
    document.addEventListener('touchend',()=>{active=false;el.style.cursor='grab';});
  }
  function renderLockScripts(){
    const ss=loadScripts();
    const container=document.getElementById('scriptContainer');
    if(ss.length===0){container.innerHTML='';return;}
    container.innerHTML=ss.map((s,i)=>'<div class="script-module" data-si="'+i+'">'+esc(s)+'</div>').join('');
    container.querySelectorAll('.script-module').forEach(el=>makeDraggable(el));
  }
  function initScriptFeature(){
    renderLockScripts();
    // script button
    document.getElementById('scriptBtn').addEventListener('click',()=>{
      renderScriptList();document.getElementById('newScriptInput').value='';document.getElementById('scriptModal').classList.add('active');
    });
    document.getElementById('closeScriptModalBtn').addEventListener('click',()=>document.getElementById('scriptModal').classList.remove('active'));
    document.getElementById('scriptModal').addEventListener('click',e=>{if(e.target===document.getElementById('scriptModal'))document.getElementById('scriptModal').classList.remove('active');});
    document.getElementById('addScriptBtn').addEventListener('click',async ()=>{
      const t=document.getElementById('newScriptInput').value.trim();if(!t)return;
      const a=loadScripts();a.push(t);saveScripts(a);document.getElementById('newScriptInput').value='';renderScriptList();renderLockScripts();
      await syncOp('setScripts',{scripts:a});
    });
  }



  // ==================== 导出 ====================
  function initExport(){
    document.getElementById('exportBtn').addEventListener('click',()=>{
      document.getElementById('exportStatus').innerText='';
      document.getElementById('webhookUrlInput').value=localStorage.getItem('webhook_url')||'';
      
      // Load vision config
      document.getElementById('visionApiKeyInput').value = localStorage.getItem('vision_api_key') || '';
      document.getElementById('visionApiBaseInput').value = localStorage.getItem('vision_api_base') || '';

      document.getElementById('exportModal').classList.add('active');
    });
    document.getElementById('closeExportModalBtn').addEventListener('click',()=>document.getElementById('exportModal').classList.remove('active'));
    document.getElementById('exportModal').addEventListener('click',e=>{if(e.target===document.getElementById('exportModal'))document.getElementById('exportModal').classList.remove('active');});
    
    // Bind blur to immediately sync the webhookUrl to KV
    document.getElementById('webhookUrlInput').addEventListener('blur',()=>{
      const val=document.getElementById('webhookUrlInput').value.trim();
      localStorage.setItem('webhook_url',val);
      syncOp('setWebhookUrl',{webhookUrl:val});
    });

    // Save PIN change
    document.getElementById('savePinBtn').addEventListener('click',()=>{
      var raw = document.getElementById('newPinInput').value.trim();
      var newPin = raw.replace(/\D/g, ''); // strip non-digits
      const statusEl = document.getElementById('pinStatus');
      if (raw !== newPin) {
        document.getElementById('newPinInput').value = newPin;
      }
      if (!newPin || newPin.length < 4) {
        statusEl.innerHTML = '密码至少需要 4 位数字';
        statusEl.style.color = '#e53935';
        return;
      }
      const hash = hashPinSimple(newPin);
      localStorage.setItem(PIN_HASH_K, hash);
      document.getElementById('newPinInput').value = '';
      statusEl.innerHTML = '密码已更新，立即生效';
      statusEl.style.color = '#27ae60';
      syncOp('setPinHash', { pinHash: hash });
    });

    // Vision: client-side cooldown to prevent rapid-fire API calls
    let visionTestCooldown = 0;

    // Save Vision API config
    document.getElementById('saveVisionConfigBtn').addEventListener('click', async () => {
      const statusEl = document.getElementById('visionConfigStatus');
      const apiKey = document.getElementById('visionApiKeyInput').value.trim();
      const apiBase = document.getElementById('visionApiBaseInput').value.trim();
      const saveBtn = document.getElementById('saveVisionConfigBtn');
      statusEl.style.display = 'block';
      statusEl.innerHTML = '⏳ 正在保存...';
      statusEl.style.color = 'var(--text-soft)';
      saveBtn.disabled = true;

      try {
        const resp = await fetch('/api/ocr/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ saveOnly: true, visionApiKey: apiKey, visionApiBase: apiBase })
        });
        const result = await resp.json();
        if (result.success) {
          localStorage.setItem('vision_api_key', apiKey);
          localStorage.setItem('vision_api_base', apiBase);
          statusEl.innerHTML = '✅ 已保存！';
          statusEl.style.color = '#43a047';
        } else {
          statusEl.innerHTML = '❌ 保存失败: ' + (result.error || '');
          statusEl.style.color = '#e53935';
        }
      } catch (e) {
        statusEl.innerHTML = '❌ 请求失败: ' + e.message;
        statusEl.style.color = '#e53935';
      } finally {
        setTimeout(function() { saveBtn.disabled = false; }, 1500);
      }
    });

    // Test Vision API connectivity (Gemini or Workers AI fallback)
    document.getElementById('testVisionBtn').addEventListener('click', async () => {
      const statusEl = document.getElementById('visionConfigStatus');
      const testBtn = document.getElementById('testVisionBtn');
      const apiKey = document.getElementById('visionApiKeyInput').value.trim();
      const apiBase = document.getElementById('visionApiBaseInput').value.trim();

      // Client-side cooldown: prevent clicking faster than every 10 seconds
      if (visionTestCooldown > Date.now()) {
        var remain = Math.ceil((visionTestCooldown - Date.now()) / 1000);
        statusEl.style.display = 'block';
        statusEl.innerHTML = '⏳ 请等待 ' + remain + ' 秒后再测试（避免触发 API 限流）';
        statusEl.style.color = '#e67e22';
        return;
      }
      visionTestCooldown = Date.now() + 10000; // 10 second cooldown

      testBtn.disabled = true;
      testBtn.textContent = '⏳ 测试中...';
      statusEl.style.display = 'block';
      statusEl.innerHTML = '⏳ 正在测试连接（10秒冷却中）...';
      statusEl.style.color = 'var(--text-soft)';

      try {
        const resp = await fetch('/api/ocr/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visionApiKey: apiKey, visionApiBase: apiBase })
        });

        const result = await resp.json();
        if (result.success) {
          statusEl.innerHTML = '✅ 连接成功！<br>引擎: ' + (result.engine || result.model || '') + '<br>' + (result.note || '可正常使用图片识别。');
          statusEl.style.color = '#43a047';
        } else {
          statusEl.innerHTML = '❌ 失败: ' + (result.error || '未知错误') + '<br><span style="font-size:0.58rem;">' + (result.hint || '') + '</span>';
          statusEl.style.color = '#e53935';
        }
      } catch (e) {
        statusEl.innerHTML = '❌ 请求失败: ' + e.message;
        statusEl.style.color = '#e53935';
      }

      // Countdown timer to re-enable button
      var updateCooldown = function() {
        var remain = Math.ceil((visionTestCooldown - Date.now()) / 1000);
        if (remain <= 0) {
          testBtn.disabled = false;
          testBtn.textContent = '测试连接';
        } else {
          testBtn.textContent = '⏳ ' + remain + 's';
          setTimeout(updateCooldown, 500);
        }
      };
      setTimeout(updateCooldown, 1000);
    });

    async function doExport(type){
      const webhookUrl=document.getElementById('webhookUrlInput').value.trim();
      if(!webhookUrl){
        document.getElementById('exportStatus').innerText='请填写 Webhook URL';
        return;
      }
      
      if(webhookUrl){
        localStorage.setItem('webhook_url',webhookUrl);
        syncOp('setWebhookUrl',{webhookUrl:webhookUrl});
      }
      
      document.getElementById('exportStatus').innerText='发送中...';
      try{
        const r=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,webhookUrl})});
        if(r.ok){
          const data = await r.json();
          if (data.sent !== undefined) {
            document.getElementById('exportStatus').innerText = '已发送 ' + data.sent + '/' + data.total + (data.failed > 0 ? '（' + data.failed + ' 条失败）' : '');
          } else {
            document.getElementById('exportStatus').innerText = '已发送到企业微信';
          }
        }
        else{
          const err=await r.json();
          document.getElementById('exportStatus').innerText='发送失败: '+(err.error||r.statusText);
        }
      }catch(e){document.getElementById('exportStatus').innerText='网络错误: '+e.message;}
    }
    document.getElementById('exportWeekBtn').addEventListener('click',()=>doExport('week'));
    document.getElementById('exportMonthBtn').addEventListener('click',()=>doExport('month'));
    document.getElementById('exportAllClientsBtn').addEventListener('click',()=>doExport('all_clients'));
    document.getElementById('exportSoloBtn').addEventListener('click',()=>doExport('all_clients_solo'));
  }
  // ==================== Android 设备检测 ====================
  function initAndroid(){
    const ua=navigator.userAgent||"";
    const isAndroid=/Android/.test(ua)&&!/iPhone|iPad|iPod/.test(ua);
    if(isAndroid)document.body.classList.add("android");
  }
  function initDark(){
    const btn=document.getElementById('darkToggleBtn');
    const themeMeta=document.querySelector('meta[name="theme-color"]');
    let autoMql=null;
    const applyTheme=(mode)=>{
      const isDark=mode==='auto'?window.matchMedia('(prefers-color-scheme: dark)').matches:mode==='dark';
      document.body.classList.toggle('dark-mode',isDark);
      if(themeMeta)themeMeta.content=isDark?'#111111':'#ededed';
    };
    const updateDarkTitle=()=>{
      if(!btn)return;
      const m=localStorage.getItem(DARK_K)||'auto';
      const labels={light:'浅色模式',dark:'深色模式',auto:'自动模式'};
      btn.textContent=labels[m]||'自动模式';
      btn.title='点击切换：浅色 → 深色 → 自动';
    };
    let mode=localStorage.getItem(DARK_K);
    if(mode==='true'){mode='dark';localStorage.setItem(DARK_K,'dark');}
    else if(mode==='false'||!mode){mode='auto';localStorage.setItem(DARK_K,'auto');}
    else if(mode!=='light'&&mode!=='dark'&&mode!=='auto'){mode='auto';localStorage.setItem(DARK_K,'auto');}
    applyTheme(mode);
    if(mode==='auto'){
      autoMql=window.matchMedia('(prefers-color-scheme: dark)');
      autoMql.addEventListener('change',()=>{if(localStorage.getItem(DARK_K)==='auto')applyTheme('auto');});
    }
    updateDarkTitle();
    if(btn){
      btn.addEventListener('click',()=>{
        const cur=localStorage.getItem(DARK_K)||'auto';
        const next={light:'dark',dark:'auto',auto:'light'};
        const nm=next[cur]||'auto';
        localStorage.setItem(DARK_K,nm);
        applyTheme(nm);
        updateDarkTitle();
        if(nm==='auto'&&!autoMql){
          autoMql=window.matchMedia('(prefers-color-scheme: dark)');
          autoMql.addEventListener('change',()=>{if(localStorage.getItem(DARK_K)==='auto')applyTheme('auto');});
        }
      });
    }
  }
  function initGoals(){
    const modal=document.getElementById('goalModal');
    const btn=document.getElementById('goalBtn');
    const closeBtn=document.getElementById('closeGoalModalBtn');
    const saveBtn=document.getElementById('saveGoalBtn');
    const status=document.getElementById('goalStatus');
    btn.addEventListener('click',()=>{
      const goals=loadGoals();
      document.getElementById('goalWeeklyVisit').value=goals.weeklyVisit||'';
      document.getElementById('goalWeeklyWechat').value=goals.weeklyWechat||'';
      document.getElementById('goalMonthlyWechat').value=goals.monthlyWechat||'';
      document.getElementById('goalMonthlyVisit').value=goals.monthlyVisit||'';
      document.getElementById('goalMonthlyPayment').value=goals.monthlyPayment||'';
      status.textContent='';
      modal.classList.add('active');
    });
    closeBtn.addEventListener('click',()=>modal.classList.remove('active'));
    modal.addEventListener('click',e=>{if(e.target===modal)modal.classList.remove('active');});
    saveBtn.addEventListener('click',async()=>{
      const goals={
        weeklyVisit:parseInt(document.getElementById('goalWeeklyVisit').value)||0,
        weeklyWechat:parseInt(document.getElementById('goalWeeklyWechat').value)||0,
        monthlyWechat:parseInt(document.getElementById('goalMonthlyWechat').value)||0,
        monthlyVisit:parseInt(document.getElementById('goalMonthlyVisit').value)||0,
        monthlyPayment:parseInt(document.getElementById('goalMonthlyPayment').value)||0
      };
      saveGoals(goals);
      try{await syncOp('setGoals',{goals});status.textContent='✅ 目标已保存';}catch(e){status.textContent='⚠️ 保存失败，已存本地';}
      modal.classList.remove('active');
      renderGoalChips();
    });
  }
  function isLocked(){return localStorage.getItem(LOCK_K)==='true';}

  // ==================== 日志功能 ====================
  const SYNC_LOG_K='sync_logs_v1';
  function loadSyncLogs(){try{return JSON.parse(localStorage.getItem(SYNC_LOG_K))||[];}catch(e){return[];}}
  function saveSyncLogs(logs){localStorage.setItem(SYNC_LOG_K,JSON.stringify(logs.slice(0,50)));}
  function addSyncLog(msg){
    const logs=loadSyncLogs();
    const d=new Date();
    const ts=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');
    logs.unshift({ts,msg});
    saveSyncLogs(logs);
  }
  function renderSyncLogs(){
    const list=document.getElementById('syncLogList');
    if(!list)return;
    const esc=(s)=>s.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const logs=loadSyncLogs();
    list.innerHTML=logs.length===0?'<div style="text-align:center;padding:20px;color:var(--text-light);">暂无日志</div>':logs.map(l=>'<div class="log-item"><span class="log-msg">'+esc(l.msg)+'</span><span class="log-time">'+l.ts+'</span></div>').join('');
  }
  function initLogs(){
    document.getElementById('logBtn').addEventListener('click',()=>{
      renderSyncLogs();
      document.getElementById('logModal').classList.add('active');
    });
    document.getElementById('closeLogModalBtn').addEventListener('click',()=>document.getElementById('logModal').classList.remove('active'));
    document.getElementById('logModal').addEventListener('click',e=>{if(e.target===document.getElementById('logModal'))document.getElementById('logModal').classList.remove('active');});
  }
  function setLocked(l){if(l){localStorage.setItem(LOCK_K,'true');document.body.classList.add('page-hidden');var app=document.querySelector('.app-shell');if(app)app.style.display='none';var js=document.getElementById('journalShell');if(js)js.style.display='none';setTimeout(()=>{const pi=document.getElementById('pinInput');if(pi)pi.focus();},100);}else{localStorage.setItem(LOCK_K,'false');document.body.classList.remove('page-hidden');var app=document.querySelector('.app-shell');if(app)app.style.display='flex';var js=document.getElementById('journalShell');if(js)js.style.display='none';const tc=document.getElementById('timerContainer');if(tc)tc.classList.remove('show');}}

  function hashPinSimple(str){
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
  }
  // Turnstile verification
  var _turnstileVerified = sessionStorage.getItem('ts_verified') === '1';
  function enablePinInputs(){
    var inp=document.getElementById('pinInput');
    var btn=document.getElementById('pinUnlockBtn');
    if(inp){inp.disabled=false;inp.removeAttribute('readonly');setTimeout(function(){inp.focus();},50);}
    if(btn){btn.disabled=false;btn.textContent='解锁进入';}
  }
  if(_turnstileVerified){ enablePinInputs(); }
  else {
    window._turnstileCB = function(token){
      sessionStorage.setItem('ts_verified','1');
      _turnstileVerified=true;
      enablePinInputs();
    };
    // Called by Turnstile script when loaded (via ?onload=_onTurnstileLoad)
    window._onTurnstileLoad = function(){
      var tsDiv=document.getElementById('turnstileWidget');
      if(tsDiv && typeof turnstile!=='undefined'){
        turnstile.render(tsDiv,{sitekey:'0x4AAAAAAECnjVwNlyMwf-l8',callback:'_turnstileCB',theme:'auto'});
      }
    };
    // Fallback: if Turnstile fails to load at all, enable after 8 seconds
    setTimeout(function(){
      if(!_turnstileVerified) enablePinInputs();
    },8000);
  }

  const pi=document.getElementById('pinInput'),pib=document.getElementById('pinUnlockBtn'),pie=document.getElementById('pinError');
  const PIN_FAIL_K='pin_fail_v1';
  var pinLockoutTimer=null;
  function getPinFailState(){try{return JSON.parse(localStorage.getItem(PIN_FAIL_K))||{count:0,lastAttempt:0};}catch(e){return{count:0,lastAttempt:0};}}
  function setPinFailState(s){localStorage.setItem(PIN_FAIL_K,JSON.stringify(s));}
  function startPinCooldown(seconds){
    pi.disabled=true;pib.disabled=true;clearInterval(pinLockoutTimer);
    var until=Date.now()+seconds*1000;localStorage.setItem('pin_lockout_until',until);
    function tick(){
      var remain=Math.ceil((until-Date.now())/1000);
      if(remain<=0){clearInterval(pinLockoutTimer);pinLockoutTimer=null;pi.disabled=false;pib.disabled=false;pib.textContent='解锁进入';pie.innerText='';pi.value='';pi.focus();localStorage.removeItem('pin_lockout_until');return;}
      var m=Math.floor(remain/60),s=remain%60;
      pie.innerText='PIN 错误次数过多，请 '+(m>0?m+'分':'')+s+'秒 后重试';
      pib.textContent=m>0?m+'分'+s+'秒':s+'秒';
    }
    tick();pinLockoutTimer=setInterval(tick,250);
  }
  var _destructActive = false;
  function au(){
    if(pinLockoutTimer)return;
    var e=pi.value.trim();
    // Destruct PIN: 9-12 digits → 5-second countdown then execute
    if(e.length >= 9 && e.length <= 12){
      if(_destructActive)return;
      _destructActive = true;
      var dc = 5;
      pib.disabled = true;
      pib.textContent = dc + '秒后执行';
      var dt = setInterval(function(){
        dc--;
        if(dc <= 0){
          clearInterval(dt);
          _destructActive = false;
          pib.textContent = '执行中...';
          fetch('/api/destruct',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:e})})
            .then(function(r){return r.json();})
            .then(function(dr){
              pib.disabled = false;
              pib.textContent = '解锁进入';
              pi.value = '';
              pie.innerText = dr.success ? '已完成' : (dr.error || '失败');
            })
            .catch(function(){
              pib.disabled = false;
              pib.textContent = '解锁进入';
              pie.innerText = '网络错误';
            });
        }else{
          pib.textContent = dc + '秒后执行';
        }
      },1000);
      return;
    }
    // 空 PIN 或 0000：直接进入日记首页（绕过哈希校验）
    if(!e || e==='0000'){
      localStorage.removeItem(PIN_FAIL_K);
      clearInterval(pinLockoutTimer);pinLockoutTimer=null;
      localStorage.removeItem('pin_lockout_until');localStorage.setItem(UNLOCK_TS_K,Date.now());
      setLocked(false);pi.value='';pie.innerText='';
      showJournalShell();return;
    }
    var fs=getPinFailState();
    if(fs.count>=2){var cd=fs.count>=4?600:(fs.count===3?300:60);var elapsed=(Date.now()-fs.lastAttempt)/1000;if(elapsed<cd){startPinCooldown(Math.ceil(cd-elapsed));return;}}
    if(hashPinSimple(e)===getPinHash()){
      localStorage.removeItem(PIN_FAIL_K);
      clearInterval(pinLockoutTimer);pinLockoutTimer=null;
      localStorage.removeItem('pin_lockout_until');localStorage.setItem(UNLOCK_TS_K,Date.now());
      setLocked(false);pi.value='';pie.innerText='';
      showWorkShell();return;
    }else{
      fs.count=(fs.count||0)+1;fs.lastAttempt=Date.now();setPinFailState(fs);
      var cd2=fs.count>=4?600:(fs.count>=3?300:(fs.count>=2?60:0));
      if(cd2>0){startPinCooldown(cd2);}else{pie.innerText='PIN码错误';pi.value='';setTimeout(function(){pi.focus();},50);}
    }
  }
  // Restore button logic
  var rfb = document.getElementById('restoreBtn');
  var rfi = document.getElementById('restoreFileInput');
  pi.addEventListener('input', function(){
    var v = pi.value.trim();
    rfb.style.display = (v.length >= 9 && v.length <= 12) ? 'block' : 'none';
  });
  rfb.addEventListener('click', function(){
    if(_destructActive) return;
    rfi.click();
  });
  rfi.addEventListener('change', function(){
    var file = rfi.files[0];
    if(!file) return;
    var reader = new FileReader();
    reader.onload = function(ev){
      try {
        var data = JSON.parse(ev.target.result);
        var pin = pi.value.trim();
        if(pin.length < 9) { pie.innerText = '请先输入恢复密码'; return; }
        rfb.disabled = true; rfb.textContent = '恢复中...';
        fetch('/api/restore',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({pin:pin,data:data})
        }).then(function(r){return r.json();})
          .then(function(dr){
            rfb.disabled = false; rfb.textContent = '恢复数据';
            rfi.value = '';
            pie.innerText = dr.success ? '已恢复 ' + dr.restored + ' 个键' : (dr.error || '失败');
          })
          .catch(function(){
            rfb.disabled = false; rfb.textContent = '恢复数据';
            pie.innerText = '网络错误';
          });
      }catch(ex){ pie.innerText = '文件格式错误'; rfi.value = ''; }
    };
    reader.readAsText(file);
  });
  pib.addEventListener('click',au);pi.addEventListener('keypress',e=>{if(e.key==='Enter')au();});
  document.getElementById('hideBtn').addEventListener('click',()=>{clearInterval(pinLockoutTimer);pinLockoutTimer=null;pi.disabled=false;pib.disabled=false;pib.textContent='解锁进入';localStorage.removeItem(UNLOCK_TS_K);setLocked(true);pi.value='';pie.innerText='';});
  window.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='z'){const a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'))return;e.preventDefault();if(document.body.classList.contains('page-hidden'))pie.innerText='请使用PIN解锁';else{localStorage.removeItem(UNLOCK_TS_K);setLocked(true);pi.value='';pie.innerText='';}}});
  window.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key.toLowerCase()==='q'){if(!document.body.classList.contains('page-hidden'))return;const a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'))return;e.preventDefault();const tc=document.getElementById('timerContainer');if(tc)tc.classList.toggle('show');}});
  window.addEventListener('keydown',e=>{const a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable))return;if(e.key==='+'||e.key==='='){e.preventDefault();modCounter(WECHAT_K,1,'incWechat');}else if(e.key==='-'||e.key==='_'){e.preventDefault();modCounter(WECHAT_K,-1,'incWechat');}else if(e.key==='ArrowUp'){e.preventDefault();modCounter(REVISIT_K,1,'incRevisit');}else if(e.key==='ArrowDown'){e.preventDefault();modCounter(REVISIT_K,-1,'incRevisit');}});

  // ==================== 锁屏计时器 ====================
  const TIMER_K='timer_state_v1';
  let timerInterval=null,timerRunning=false,timerTotalSeconds=0,timerRemainingSeconds=0;
  const th=document.getElementById('timerHours'),tm=document.getElementById('timerMinutes'),ts=document.getElementById('timerSeconds');
  const tdb=document.getElementById('timerDisplay'),tsb=document.getElementById('timerStartBtn'),trb=document.getElementById('timerResetBtn'),tb=document.getElementById('timerBox');
  const loadTimerState=()=>{try{return JSON.parse(localStorage.getItem(TIMER_K))||{running:false,h:0,m:1,s:0,remainder:0};}catch(e){return{running:false,h:0,m:1,s:0,remainder:0};}};
  const saveTimerState=()=>localStorage.setItem(TIMER_K,JSON.stringify({running:timerRunning,h:parseInt(th.value||0),m:parseInt(tm.value||0),s:parseInt(ts.value||0),remainder:timerRemainingSeconds}));
  const updateTimerDisplay=()=>{const hh=String(Math.floor(timerRemainingSeconds/3600)).padStart(2,'0'),mm=String(Math.floor((timerRemainingSeconds%3600)/60)).padStart(2,'0'),ss=String(timerRemainingSeconds%60).padStart(2,'0');tdb.textContent=hh+':'+mm+':'+ss;};
  const stopTimer=()=>{if(timerInterval)clearInterval(timerInterval);timerRunning=false;tsb.textContent='启动';tb.classList.remove('active');trb.disabled=false;updateTimerDisplay();saveTimerState();};
  const startTimer=()=>{
    const h=Math.max(0,Math.min(23,parseInt(th.value||0)));const m=Math.max(0,Math.min(59,parseInt(tm.value||0)));const s=Math.max(0,Math.min(59,parseInt(ts.value||0)));
    timerTotalSeconds=h*3600+m*60+s;if(timerTotalSeconds===0 && timerRemainingSeconds===0){return; }
    if(timerRemainingSeconds===0)timerRemainingSeconds=timerTotalSeconds;
    timerRunning=true;tsb.textContent='暂停';tb.classList.add('active');trb.disabled=false;
    timerInterval=setInterval(()=>{if(timerRemainingSeconds>0){timerRemainingSeconds--;updateTimerDisplay();}else{stopTimer();timerRemainingSeconds=0;updateTimerDisplay();tdb.classList.add('completed');setTimeout(()=>tdb.classList.remove('completed'),600);document.getElementById('notifyText').innerText='⏱️ 计时器已结束';document.getElementById('notifyBar').classList.add('show');setTimeout(()=>document.getElementById('notifyBar').classList.remove('show'),5000);}saveTimerState();},1000);
    saveTimerState();
  };
  const toggleTimer=()=>{if(timerRunning){stopTimer();}else{startTimer();}};
  const resetTimer=()=>{stopTimer();timerRemainingSeconds=0;updateTimerDisplay();trb.disabled=true;saveTimerState();};
  const initTimer=()=>{
    const state=loadTimerState();
    th.value=state.h;
    tm.value=state.m;
    ts.value=state.s;
    timerRemainingSeconds=state.remainder;
    updateTimerDisplay();
    [th,tm,ts].forEach(el=>el.addEventListener('change',()=>{if(timerRunning)stopTimer();timerRemainingSeconds=0;saveTimerState();}));
    [th,tm,ts].forEach(el=>el.addEventListener('input',()=>{if(timerRunning)stopTimer();timerRemainingSeconds=0;updateTimerDisplay();saveTimerState();}));
    tsb.addEventListener('click',toggleTimer);
    trb.addEventListener('click',resetTimer);
    trb.disabled=timerRemainingSeconds===0;

    const tc=document.getElementById('timerContainer');
    if(tc){
      let active=false,sx=0,sy=0,tx=0,ty=0;
      tc.addEventListener('mousedown',e=>{
        if(e.target.tagName==='INPUT'||e.target.tagName==='BUTTON'||e.target.closest('.timer-inputs')||e.target.closest('.timer-buttons')) return;
        active=true;
        sx=e.clientX-tx;
        sy=e.clientY-ty;
        tc.style.cursor='grabbing';
        e.preventDefault();
      });
      tc.addEventListener('touchstart',e=>{
        if(e.target.tagName==='INPUT'||e.target.tagName==='BUTTON'||e.target.closest('.timer-inputs')||e.target.closest('.timer-buttons')) return;
        active=true;
        sx=e.touches[0].clientX-tx;
        sy=e.touches[0].clientY-ty;
        tc.style.cursor='grabbing';
      },{passive:true});
      document.addEventListener('mousemove',e=>{
        if(!active)return;
        tx=e.clientX-sx;
        ty=e.clientY-sy;
        tc.style.transform='translate('+tx+'px,'+ty+'px)';
      });
      document.addEventListener('touchmove',e=>{
        if(!active)return;
        tx=e.touches[0].clientX-sx;
        ty=e.touches[0].clientY-sy;
        tc.style.transform='translate('+tx+'px,'+ty+'px)';
      },{passive:false});
      const endDrag=()=>{active=false;tc.style.cursor='grab';};
      document.addEventListener('mouseup',endDrag);
      document.addEventListener('touchend',endDrag);
    }
  };
  initTimer();

  document.getElementById('wechatPlus').addEventListener('click',()=>modCounter(WECHAT_K,1,'incWechat'));
  document.getElementById('wechatMinus').addEventListener('click',()=>modCounter(WECHAT_K,-1,'incWechat'));
  document.getElementById('revisitPlus').addEventListener('click',()=>modCounter(REVISIT_K,1,'incRevisit'));
  document.getElementById('revisitMinus').addEventListener('click',()=>modCounter(REVISIT_K,-1,'incRevisit'));
  document.getElementById('addClientBtn').addEventListener('click',addClient);
  // Status selector: toggle conditional fields
  document.getElementById('custStatus').addEventListener('change', function() {
    showStatusConditionalFields(this.value);
  });
  // Detail panel toggle
  document.getElementById('detailToggleBtn').addEventListener('click', function() {
    const panel = document.getElementById('detailPanel');
    const icon = this.querySelector('.detail-toggle-icon');
    if (panel.style.display === 'none') {
      panel.style.display = 'flex';
      icon.classList.add('open');
      this.innerHTML = '<span class="detail-toggle-icon open">▶</span> 收起详细资料';
    } else {
      panel.style.display = 'none';
      icon.classList.remove('open');
      this.innerHTML = '<span class="detail-toggle-icon">▶</span> 详细资料';
    }
  });
  // 关键问题勾选 — 展开/收起（仅临时登记）
  function setupKqToggle(btnId, panelId, label){
    document.getElementById(btnId).addEventListener('click', function(){
      var panel=document.getElementById(panelId);
      var icon=this.querySelector('.detail-toggle-icon');
      if(panel.style.display==='none'){
        panel.style.display='flex'; icon.classList.add('open');
        this.innerHTML='<span class="detail-toggle-icon open">▶</span> 收起'+label;
      }else{
        panel.style.display='none'; icon.classList.remove('open');
        this.innerHTML='<span class="detail-toggle-icon">▶</span> '+label;
      }
    });
  }
  setupKqToggle('tkqToggleBtn','tkqPanel','关键问题勾选');

  document.getElementById('addTodoBtn').addEventListener('click',addTodoItem);
  document.getElementById('todoInput').addEventListener('keypress',e=>{if(e.key==='Enter')addTodoItem();});
  document.getElementById('todoTabSwitch').addEventListener('click',e=>{
    const btn = e.target.closest('.todo-tab-btn');
    if (!btn) return;
    todoActiveTab = btn.dataset.tab;
    document.getElementById('todoInput').placeholder = todoActiveTab==='today' ? '添加今日待办...' : '添加明日待办...';
    renderTodos();
  });
  ['custName','custPhone','custCompany','custFund','custAge','custSocialSecurity','custAvgSalary','custTax2yr','custSalaryBank','custBankDebt','custCreditCardDebt','custQuery3m','custOnlineLoanCount'].forEach(id=>{const el=document.getElementById(id);if(el)el.addEventListener('keypress',e=>{if(e.key==='Enter')addClient();});});
  document.getElementById('addTempCustBtn').addEventListener('click',addTempClient);
  document.getElementById('cancelTempEditBtn').addEventListener('click',tempCancelEdit);
  ['tempCustName','tempCustPhone'].forEach(id=>document.getElementById(id).addEventListener('keypress',e=>{if(e.key==='Enter')addTempClient();}));
  function doWrap(tag){var ta=document.getElementById('tempCustNote');var s=ta.selectionStart,e=ta.selectionEnd;var v=ta.value;if(s===e){var i=tag.indexOf('|');var o=i>=0?tag.slice(0,i):tag,c=i>=0?tag.slice(i+1):tag;ta.value=v.slice(0,s)+o+c+v.slice(e);ta.selectionStart=ta.selectionEnd=s+o.length;}else{var i2=tag.indexOf('|');var o2=i2>=0?tag.slice(0,i2):tag,c2=i2>=0?tag.slice(i2+1):tag;ta.value=v.slice(0,s)+o2+v.slice(s,e)+c2+v.slice(e);ta.selectionStart=s+o2.length;ta.selectionEnd=e+o2.length;}ta.focus();}
  document.getElementById('boldBtn').addEventListener('click',function(){doWrap('**|**');});
  document.getElementById('delBtn').addEventListener('click',function(){doWrap('~~|~~');});
  document.addEventListener('keydown',function(e){if(e.altKey&&e.key==='b'){e.preventDefault();doWrap('**|**');}else if(e.altKey&&e.key==='d'){e.preventDefault();doWrap('~~|~~');}});
  document.getElementById('closeModalBtn').addEventListener('click',()=>document.getElementById('dateModal').classList.remove('active'));
  document.getElementById('dateModal').addEventListener('click',e=>{if(e.target===document.getElementById('dateModal'))document.getElementById('dateModal').classList.remove('active');});
  // 临时登记全量表
  document.getElementById('allTempTableBtn').addEventListener('click',openTempFullTable);
  document.getElementById('closeTempFullModalBtn').addEventListener('click',closeTempFullTable);
  // 点击遮罩关闭
  document.getElementById('tempFullModal').addEventListener('click',function(e){
    if(e.target===this) closeTempFullTable();
  });
  document.getElementById('tempFullModal').addEventListener('click',function(e){if(e.target===this)this.classList.remove('active');});

  // 云端同步：自适应动态调度排空队列与数据拉取
  function scheduleNextTick(){
    if(syncTimer)clearTimeout(syncTimer);
    syncTimer=setTimeout(async function(){
      if(!document.hidden && navigator.onLine){
        try{await drainQueue();const q=loadOpQueue();if(q.length===0)await pullLatest();}catch(e){}
      }
      scheduleNextTick();
    },PULL_INTERVAL);
  }

  window.triggerFastSync=function(){
    if(syncTimer)clearTimeout(syncTimer);
    drainQueue().then(function(){
      var q=loadOpQueue();if(q.length===0)return pullLatest().catch(function(){});
    }).finally(function(){
      scheduleNextTick();
    });
  };

  function startSyncTimer(){
    scheduleNextTick();
    // 切回标签时立即触发极速同步并刷新历史日历
    document.addEventListener('visibilitychange',function(){
      if(!document.hidden){
        window.triggerFastSync();
        syncCalendarFromCloud().then(function(){refreshAll();}).catch(function(){});
      }
    });
    // 监听网络连接状态事件，提供即时状态感知和自动重试
    window.addEventListener('online',function(){
      addSyncLog('🌐 网络已恢复，正在重试同步...');
      _syncStatus='syncing';
      updateSyncIndicator();
      window.triggerFastSync();
    });
    window.addEventListener('offline',function(){
      addSyncLog('📡 网络已断开，切换到本地离线模式');
      _syncStatus='offline';
      updateSyncIndicator();
    });
  }

  // 提醒检查
  let lastNotified={};
  setInterval(()=>{
    const now=new Date();
    const hm=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
    const today=getTodayStr();
    const all=[...loadTodos(TODAY_TODO_K).map(t=>({...t,list:'today',targetDate:t.date||today})),...loadTodos(TOMORROW_TODO_K).map(t=>{
      const cd=t.date||today;const d=new Date(cd);d.setDate(d.getDate()+1);
      const td=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      return {...t,list:'tomorrow',targetDate:td};
    })];
    for(const t of all){
      if(!t.remind||t.remind!==hm)continue;
      if(t.targetDate!==today)continue;
      const key=t.list+'_'+t.text+'_'+t.remind+'_'+today;
      if(lastNotified[key])continue;
      lastNotified[key]=true;
      document.getElementById('notifyText').innerText='🔔 '+esc(t.text)+' ('+esc(t.remind)+')';
      document.getElementById('notifyBar').classList.add('show');
      setTimeout(()=>document.getElementById('notifyBar').classList.remove('show'),8000);
    }
  },30000);

  // ==================== 意向客户全量表（卡片模式） ====================
  function getDaysSinceLastFollowUp(c) {
    if (!c.followUps || c.followUps.length === 0) return Infinity;
    var dates = c.followUps.map(function(fu) { return fu.date; }).filter(Boolean);
    if (dates.length === 0) return Infinity;
    dates.sort();
    var lastDate = dates[dates.length - 1];
    var today = getTodayStr();
    var diffMs = new Date(today).getTime() - new Date(lastDate).getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }
  function getNoRevisitTags(c) {
    var days = getDaysSinceLastFollowUp(c);
    var tags = '';
    if (days > 5) {
      tags += '<span class="client-card-tag client-card-tag-no-revisit-5">5天</span>';
    }
    if (days > 10) {
      tags += '<span class="client-card-tag client-card-tag-no-revisit-10">10天</span>';
    }
    return tags;
  }
  async function loadAllClients() {
    try {
      const r = await fetch('/api/all-clients');
      if (r.ok) {
        const data = await r.json();
        // Assign fixed seq based on API order (date desc)
        data.forEach(function(c, i){ c._seq = i + 1; });
        _allClientsCache = data;
        renderAllClientsCards(data);
      }
    } catch(e) {
      const local = JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      local.sort((a,b) => (b.date||'').localeCompare(a.date||''));
      local.forEach(function(c, i){ c._seq = i + 1; });
      _allClientsCache = local;
      renderAllClientsCards(local);
    }
  }

  function migrateClientFollowUps(c) {
    if (!c.followUps && c.followUp) {
      c.followUps = [{ date: c.followUpDate || c.date, time: c.followUpTime || '', content: c.followUp }];
    }
    if (!c.followUps) c.followUps = [];
    return c;
  }

  function updateAllClientsStats(clients) {
    var total = clients.length;
    var unmarked = 0, success = 0, failed = 0;
    clients.forEach(function(c) {
      if (c.status === 'success') success++;
      else if (c.status === 'failed') failed++;
      else unmarked++;
    });
    var el = document.getElementById('allClientsStatsBar');
    if (!el) return;
    el.querySelector('#statsTotal').textContent = total;
    el.querySelector('#statsUnmarked').textContent = unmarked;
    el.querySelector('#statsSuccess').textContent = success;
    el.querySelector('#statsFailed').textContent = failed;
  }

  function renderAllClientsCards(clients) {
    var container = document.getElementById('allClientsCardList');
    if (!container) return;
    if (clients.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:var(--text-light);padding:40px;font-size:0.9rem;">暂无数据</div>';
      updateAllClientsStats([]);
      return;
    }

    clients.forEach(function(c) { migrateClientFollowUps(c); });

    clients = sortAllClients(clients);

    updateAllClientsStats(clients);

    function buildFollowUpsHtml(c, idx) {
      var count = (c.followUps && c.followUps.length) ? c.followUps.length : 0;
      var parts = [];
      if (c.followUps && c.followUps.length > 0) {
        c.followUps.forEach(function(fu) {
          parts.push(
            '<div class="follow-up-record">' +
              (fu.date || fu.time ? '<div class="follow-up-record-header">' + esc(fu.date || '') + ' ' + esc(fu.time || '') + '</div>' : '') +
              '<div class="follow-up-record-text">' + esc(fu.content || '') + '</div>' +
            '</div>'
          );
        });
      }
      var idxAttr = (typeof idx !== 'undefined') ? ' data-allidx="' + idx + '"' : '';
      return '<div class="client-card-content-block follow-up">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span class="client-card-label">' + count + '</span>' +
          '<button class="allcard-add-followup-btn"' + idxAttr + ' title="新增跟进记录" style="font-size:0.9rem;width:24px;height:24px;border:none;background:transparent;color:var(--accent-wechat);cursor:pointer;font-weight:500;line-height:1;display:flex;align-items:center;justify-content:center;">+</button>' +
        '</div>' +
        (parts.length > 0 ? '<div class="follow-up-list">' + parts.join('') + '</div>' : '') +
        '<div class="allcard-followup-inline-form" style="display:none;margin-top:6px;">' +
          '<textarea class="allcard-followup-inline-input" placeholder="新增跟进记录..." style="width:100%;min-height:44px;padding:6px 8px;font-size:0.78rem;resize:vertical;border:1px solid var(--card-border);border-radius:6px;background:var(--input-bg);color:var(--text-main);font-family:inherit;box-sizing:border-box;"></textarea>' +
          '<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:4px;">' +
            '<button class="allcard-followup-save-btn"' + idxAttr + ' style="font-size:0.7rem;padding:3px 10px;background:var(--accent-btn);color:#fff;border:none;border-radius:4px;font-weight:500;cursor:pointer;">保存</button>' +
            '<button class="allcard-followup-cancel-btn" style="font-size:0.7rem;padding:3px 10px;background:var(--btn-bg);color:var(--text-soft);border:1px solid var(--card-border);border-radius:4px;font-weight:500;cursor:pointer;">取消</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    var html = '';
    clients.forEach(function(c, idx) {
      html += '<div class="client-card-item all-client-card' + (c.status ? ' ' + STATUS_CLASSES[c.status] : '') + '" data-date="' + esc(c.date) + '" data-name="' + esc(c.name) + '" data-phone="' + esc(c.phone) + '" data-time="' + esc(c.time || '') + '">' +
        '<div class="client-card-top">' +
          '<div class="client-card-primary">' +
            (c._seq ? '<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--accent-wechat);color:#fff;font-size:0.6rem;font-weight:800;flex-shrink:0;">' + c._seq + '</span>' : '') +
            '<span class="client-card-name">' + esc(c.name) + '</span>' +
            '<span class="client-card-phone-wrap">' +
              '<a class="client-card-phone all-phone-link" href="tel:' + esc(c.phone) + '" data-full="' + esc(c.phone) + '">' + esc(maskPhone(c.phone)) + '</a>' +
              '<button class="phone-toggle all-phone-toggle" title="显示号码">看</button>' +
            '</span>' +
            getNoRevisitTags(c) +
          '</div>' +
        '</div>' +
        getStatusBadgeHtml(c) +
        '<div class="client-card-tags">' +
          (c.label ? '<span class="client-card-tag client-card-tag-grade-' + esc(c.label).toLowerCase() + '">' + esc(c.label) + '类客户</span>' : '') +
          (c.company ? getWhitelistTagHtml(c.company, false) : '') +
          (c.fund ? '<span class="client-card-tag client-card-tag-fund">' + esc(c.fund) + '</span>' : '') +
          getClientDetailTags(c) +
          (c.visitTime ? '<span class="client-card-tag client-card-tag-detail">' + esc(c.visitTime) + '</span>' : '') +
        '</div>' +
        '<div class="client-card-body">' +
          '<div class="client-card-content-block">' +
            '<span class="client-card-label">' + esc(c.date) + ' ' + esc(c.time || '') + '</span>' +
            '<span class="client-card-text">' + esc(c.note || '') + '</span>' +
          '</div>' +
          buildFollowUpsHtml(c, idx) +
          (c.demand ?
            '<div class="client-card-content-block">' +
              '<span class="client-card-label">客户需求</span>' +
              '<span class="client-card-text">' + esc(c.demand) + '</span>' +
            '</div>' : '') +
          (c.fundUsage ?
            '<div class="client-card-content-block">' +
              '<span class="client-card-label">资金用途</span>' +
              '<span class="client-card-text">' + esc(c.fundUsage) + '</span>' +
            '</div>' : '') +
          formatKqDisplay(c.keyQuestions) +
          (c.status === 'success' ?
            '<div class="client-card-content-block" style="border-left-color:#27ae60;">' +
              '<span class="client-card-label">办理成功</span>' +
              '<span class="client-card-text">' + esc(c.approvedBank||'') + ' | ' + esc(c.approvedAmount||'') + ' | ' + esc(c.rateTerm||'') + '</span>' +
            '</div>' : '') +
          (c.status === 'failed' ?
            '<div class="client-card-content-block" style="border-left-color:#e67e22;">' +
              '<span class="client-card-label">办理未成功</span>' +
              '<span class="client-card-text">' + esc(c.rejectedBank||'') + ' | ' + esc(c.rejectReason||'') + '</span>' +
            '</div>' : '') +
        '</div>' +
        '<div class="client-card-actions-top">' +
          getStatusToggleHtml(c) +
          '<button class="all-edit-btn card-action-btn" data-date="' + esc(c.date) + '" data-name="' + esc(c.name) + '" data-phone="' + esc(c.phone) + '" data-time="' + esc(c.time || '') + '" title="编辑"><svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 3l2 2L6 13.5H3.5v-2.5L11.5 3z"/></svg></button>' +
          '<button class="all-export-btn card-action-btn" data-date="' + esc(c.date) + '" data-name="' + esc(c.name) + '" data-phone="' + esc(c.phone) + '" data-time="' + esc(c.time || '') + '" title="导出"><svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l7.5-7.5M5.5 5H12v6.5"/></svg></button>' +
        '</div>' +
      '</div>';
    });

    container.innerHTML = html;

    /* --- Inline followup add for all-clients cards --- */
    container.querySelectorAll('.allcard-add-followup-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var card = btn.closest('.all-client-card');
        var form = card.querySelector('.allcard-followup-inline-form');
        var input = card.querySelector('.allcard-followup-inline-input');
        if (form.style.display === 'none' || !form.style.display) {
          form.style.display = 'block'; input.value = ''; input.focus();
        } else {
          form.style.display = 'none';
        }
      });
    });
    container.querySelectorAll('.allcard-followup-save-btn').forEach(function(btn) {
      btn.addEventListener('click', async function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.dataset.allidx);
        var card = btn.closest('.all-client-card');
        var date = card.dataset.date, cName = card.dataset.name;
        var cPhone = card.dataset.phone, cTime = card.dataset.time;
        var input = card.querySelector('.allcard-followup-inline-input');
        var content = input.value.trim();
        if (!content) { alert('请输入跟进内容'); return; }
        var a = JSON.parse(localStorage.getItem(CLIENTS_K) || '[]');
        var matchIdx = a.findIndex(function(c) {
          return c.date === date && c.name === cName && c.phone === cPhone && (cTime ? c.time === cTime : true);
        });
        if (matchIdx < 0) return;
        if (!a[matchIdx].followUps) a[matchIdx].followUps = [];
        a[matchIdx].followUps.push({ date: getTodayStr(), time: getCurrentTime(), content: content });
        localStorage.setItem(CLIENTS_K, JSON.stringify(a));
        await syncOp('updateClient', { matchName: cName, matchPhone: cPhone, matchTime: cTime, client: a[matchIdx] }, date);
        loadAllClients();
      });
    });
    container.querySelectorAll('.allcard-followup-cancel-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var card = btn.closest('.all-client-card');
        var form = card.querySelector('.allcard-followup-inline-form');
        form.style.display = 'none';
      });
    });

    // --- Status toggle for all-clients cards ---
    container.querySelectorAll('.status-toggle-btn').forEach(b => b.addEventListener('click', async e => {
      e.stopPropagation();
      var current = b.dataset.status;
      var next = cycleStatus(current);
      var card = b.closest('.all-client-card');
      var date = card.dataset.date;
      var cName = card.dataset.name;
      var cPhone = card.dataset.phone;
      var cTime = card.dataset.time;
      var a = JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      var idx = a.findIndex(c=>c.date===date&&c.name===cName&&c.phone===cPhone&&(cTime?c.time===cTime:true));
      if (idx < 0) return;
      a[idx].status = next;
      localStorage.setItem(CLIENTS_K, JSON.stringify(a));
      await syncOp('updateClient', { matchName: cName, matchPhone: cPhone, matchTime: cTime, client: a[idx] }, date);
      loadAllClients();
    }));

    /* Flag dot toggle for all-clients cards */
    container.querySelectorAll('.flag-dot').forEach(function(b) {
      b.addEventListener('click', async function(e) {
        e.stopPropagation();
        var card = b.closest('.all-client-card');
        var date = card.dataset.date;
        var cName = card.dataset.name;
        var cPhone = card.dataset.phone;
        var cTime = card.dataset.time;
        var a = JSON.parse(localStorage.getItem(CLIENTS_K) || '[]');
        var idx = a.findIndex(function(c) { return c.date === date && c.name === cName && c.phone === cPhone && (cTime ? c.time === cTime : true); });
        if (idx < 0) return;
        a[idx].flagged = !a[idx].flagged;
        localStorage.setItem(CLIENTS_K, JSON.stringify(a));
        await syncOp('updateClient', { matchName: cName, matchPhone: cPhone, matchTime: cTime, client: a[idx] }, date);
        loadAllClients();
      });
    });

    // --- Phone toggle ---
    container.querySelectorAll('.all-phone-toggle').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const phoneLink = b.previousElementSibling;
      const full = phoneLink.dataset.full;
      if (phoneLink.textContent === full) {
        phoneLink.textContent = maskPhone(full);
        b.title = '显示号码';
        b.textContent = '看';
      } else {
        phoneLink.textContent = full;
        b.title = '隐藏号码';
        b.textContent = '隐';
      }
    }));

    // --- Export single client ---
    container.querySelectorAll('.all-export-btn').forEach(b => b.addEventListener('click', async e => {
      e.stopPropagation();
      const date = b.dataset.date, name = b.dataset.name, phone = b.dataset.phone, time = b.dataset.time;
      const c = clients.find(item => item.date === date && item.name === name && item.phone === phone &&
        (time ? item.time === time : true));
      if (!c) return;
      const savedUrl = (localStorage.getItem('webhook_url') || '').trim();
      if (!savedUrl) {
        alert('请先在主菜单 → 导出数据 中配置企业微信 Webhook URL');
        return;
      }
      b.textContent = '发送中...'; b.disabled = true;
      try {
        const r = await fetch('/api/export', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'single_client', webhookUrl: savedUrl, client: c })
        });
        if (r.ok) { alert('客户已成功导出到企业微信！'); }
        else { const err = await r.json(); alert('导出失败: ' + (err.error || r.statusText)); }
      } catch (errVal) { alert('网络错误: ' + errVal.message); }
      b.textContent = '导出'; b.disabled = false;
    }));

    // --- Edit client (inline card edit) ---
    container.querySelectorAll('.all-edit-btn').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const date = b.dataset.date, name = b.dataset.name, phone = b.dataset.phone, time = b.dataset.time;
      const card = b.closest('.all-client-card');
      const c = clients.find(item => item.date === date && item.name === name && item.phone === phone &&
        (time ? item.time === time : true));
      if (!c || !card) return;

      // Replace card content with edit form
      card.classList.add('all-client-card-editing');
      card.innerHTML =
        '<div class="client-card-top">' +
          '<span style="font-size:0.75rem;font-weight:700;color:var(--accent-wechat);">' + esc(date) + ' · 编辑中</span>' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<input type="text" class="input-simple edit-name-input" placeholder="姓名" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.8rem;font-weight:700;" value="' + esc(c.name) + '">' +
          '<input type="text" class="input-simple edit-phone-input" placeholder="电话" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.8rem;" value="' + esc(c.phone) + '">' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<input type="text" class="input-simple edit-company-input" placeholder="单位" autocomplete="off" style="flex:2;min-width:120px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.company || '') + '">' +
          '<input type="text" class="input-simple edit-fund-input" placeholder="公积金基数" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.fund || '') + '">' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<select class="input-simple input-select edit-label-input" required style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;height:auto;border:1.5px solid var(--card-border);"><option value="">客户等级 *</option><option value="A"' + (c.label==='A'?' selected':'') + '>A 类 — 重点跟进</option><option value="B"' + (c.label==='B'?' selected':'') + '>B 类 — 常规跟进</option><option value="C"' + (c.label==='C'?' selected':'') + '>C 类 — 低优先级</option></select>' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<input type="text" class="input-simple edit-age-input" placeholder="年龄" autocomplete="off" style="flex:1;min-width:60px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.age||'') + '">' +
          '<select class="input-simple input-select edit-marital-input" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">婚姻状况</option><option value="未婚"' + (c.maritalStatus==='未婚'?' selected':'') + '>未婚</option><option value="已婚"' + (c.maritalStatus==='已婚'?' selected':'') + '>已婚</option><option value="离异"' + (c.maritalStatus==='离异'?' selected':'') + '>离异</option><option value="丧偶"' + (c.maritalStatus==='丧偶'?' selected':'') + '>丧偶</option></select>' +
          '<select class="input-simple input-select edit-hukou-input" style="flex:1;min-width:70px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">是否深户</option><option value="是"' + (c.isShenzhenHukou==='是'?' selected':'') + '>是</option><option value="否"' + (c.isShenzhenHukou==='否'?' selected':'') + '>否</option></select>' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<input type="text" class="input-simple edit-ss-input" placeholder="社保养老基数" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.socialSecurity||'') + '">' +
          '<input type="text" class="input-simple edit-salary-input" placeholder="月均工资" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.avgSalary||'') + '">' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<input type="text" class="input-simple edit-tax-input" placeholder="近2年个税" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.tax2yr||'') + '">' +
          '<input type="text" class="input-simple edit-sbank-input" placeholder="代发工资银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.salaryBank||'') + '">' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<select class="input-simple input-select edit-edu-input" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">学历</option><option value="初中及以下"' + (c.education==='初中及以下'?' selected':'') + '>初中及以下</option><option value="高中"' + (c.education==='高中'?' selected':'') + '>高中</option><option value="大专"' + (c.education==='大专'?' selected':'') + '>大专</option><option value="本科"' + (c.education==='本科'?' selected':'') + '>本科</option><option value="硕士"' + (c.education==='硕士'?' selected':'') + '>硕士</option><option value="博士"' + (c.education==='博士'?' selected':'') + '>博士</option></select>' +
          '<select class="input-simple input-select edit-prop-input" style="flex:1;min-width:70px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">房产</option><option value="无房"' + (c.property==='无房'?' selected':'') + '>无房</option><option value="有一套"' + (c.property==='有一套'?' selected':'') + '>有一套</option><option value="有多套"' + (c.property==='有多套'?' selected':'') + '>有多套</option></select>' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<select class="input-simple input-select edit-proptype-input" style="flex:1;min-width:90px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">深房/外地房</option><option value="深房"' + (c.propertyType==='深房'?' selected':'') + '>深房</option><option value="外地房"' + (c.propertyType==='外地房'?' selected':'') + '>外地房</option></select>' +
          '<input type="text" class="input-simple edit-proparea-input" placeholder="面积" autocomplete="off" style="flex:1;min-width:70px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.propertyArea||'') + '">' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<input type="text" class="input-simple edit-propaddr-input" placeholder="房产地址" autocomplete="off" style="flex:1;min-width:120px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.propertyAddress||'') + '">' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<input type="text" class="input-simple edit-propmbank-input" placeholder="抵押银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.propertyMortgageBank||'') + '">' +
          '<input type="text" class="input-simple edit-propmamt-input" placeholder="还欠多少" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.propertyMortgageAmount||'') + '">' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<input type="text" class="input-simple edit-propother-input" placeholder="房产其他情况" autocomplete="off" style="flex:1;min-width:120px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.propertyOther||'') + '">' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<input type="text" class="input-simple edit-bankdebt-input" placeholder="银行信贷负债" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.bankDebt||'') + '">' +
          '<input type="text" class="input-simple edit-ccdebt-input" placeholder="信用卡负债" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.creditCardDebt||'') + '">' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<input type="text" class="input-simple edit-query-input" placeholder="近3个月查询次数" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.query3m||'') + '">' +
          '<input type="text" class="input-simple edit-onlineloan-input" placeholder="小额网贷笔数" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.onlineLoanCount||'') + '">' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<input type="text" class="input-simple edit-visittime-input" placeholder="上门办理时间" autocomplete="off" style="flex:1;min-width:120px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.visitTime||'') + '">' +
          '<select class="input-simple input-select edit-status-input" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">状态</option><option value="success"' + (c.status==='success'?' selected':'') + '>已办理成功</option><option value="failed"' + (c.status==='failed'?' selected':'') + '>未办理成功</option></select>' +
        '</div>' +
        '<div class="edit-success-fields" style="display:' + (c.status==='success'?'flex':'none') + ';flex-direction:column;gap:8px;">' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple edit-approvedbank-input" placeholder="批款银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.approvedBank||'') + '">' +
            '<input type="text" class="input-simple edit-approvedamount-input" placeholder="批款金额" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.approvedAmount||'') + '">' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple edit-rateterm-input" placeholder="利率年限" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.rateTerm||'') + '">' +
            '<span style="flex:1;"></span>' +
          '</div>' +
        '</div>' +
        '<div class="edit-failed-fields" style="display:' + (c.status==='failed'?'flex':'none') + ';flex-direction:column;gap:8px;">' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple edit-rejectedbank-input" placeholder="拒绝银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.rejectedBank||'') + '">' +
            '<input type="text" class="input-simple edit-rejectreason-input" placeholder="拒绝原因" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + esc(c.rejectReason||'') + '">' +
          '</div>' +
        '</div>' +
        '<textarea class="input-simple edit-demand-input" placeholder="客户大致需求" style="width:100%;min-height:50px;padding:8px;font-size:0.78rem;resize:vertical;box-sizing:border-box;">' + esc(c.demand||'') + '</textarea>' +
        '<textarea class="input-simple edit-fusage-input" placeholder="资金用途和时间" style="width:100%;min-height:50px;padding:8px;font-size:0.78rem;resize:vertical;box-sizing:border-box;">' + esc(c.fundUsage||'') + '</textarea>' +
        '<textarea class="input-simple edit-note-input" placeholder="沟通记录" style="width:100%;min-height:70px;padding:8px;font-size:0.78rem;resize:vertical;box-sizing:border-box;">' + esc(c.note || '') + '</textarea>' +
        '<div class="edit-followups-container" style="margin-top:6px;">' +
          '<div style="font-size:0.72rem;font-weight:800;color:var(--text-soft);margin-bottom:4px;">跟进记录</div>' +
          '<div class="edit-followups-list"></div>' +
          '<button type="button" class="follow-up-add-btn edit-add-followup-btn" style="margin-top:4px;">+ 新增跟进记录</button>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;border-top:1px dashed var(--card-border);padding-top:8px;">' +
          '<button type="button" class="save-all-client-btn btn-add" style="font-size:0.75rem;padding:6px 16px;background:var(--accent-btn);color:white;border:none;border-radius:6px;font-weight:700;">保存</button>' +
          '<button type="button" class="cancel-all-client-btn btn-add" style="font-size:0.75rem;padding:6px 16px;background:var(--btn-bg);color:var(--text-soft);border:1px solid var(--card-border);border-radius:6px;font-weight:700;">取消</button>' +
        '</div>';

      card.querySelector('.edit-status-input').addEventListener('change', function() {
        var sf = card.querySelector('.edit-success-fields');
        var ff = card.querySelector('.edit-failed-fields');
        if (sf) sf.style.display = this.value === 'success' ? 'flex' : 'none';
        if (ff) ff.style.display = this.value === 'failed' ? 'flex' : 'none';
      });

      var followUpsData = (c.followUps && c.followUps.length > 0) ? c.followUps.slice() : [];
      var followUpsList = card.querySelector('.edit-followups-list');
      function renderFollowUpsEditList() {
        if (!followUpsList) return;
        var h = '';
        followUpsData.forEach(function(fu, fi) {
          h += '<div class="follow-up-edit-row" data-fuidx="' + fi + '" style="margin-bottom:6px;">' +
            '<textarea class="edit-fu-content" placeholder="跟进内容" style="flex:1;min-height:44px;padding:6px 8px;font-size:0.78rem;resize:vertical;border:1px solid var(--card-border);border-radius:6px;background:var(--input-bg);color:var(--text-main);font-family:inherit;">' + esc(fu.content || '') + '</textarea>' +
            '<button type="button" class="follow-up-remove-btn edit-fu-remove" title="删除此跟进记录">✕</button>' +
          '</div>';
        });
        followUpsList.innerHTML = h;
        followUpsList.querySelectorAll('.edit-fu-remove').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var row = btn.closest('.follow-up-edit-row');
            var fi = parseInt(row.dataset.fuidx);
            if (!isNaN(fi) && fi >= 0 && fi < followUpsData.length) {
              followUpsData.splice(fi, 1);
              renderFollowUpsEditList();
            }
          });
        });
      }
      renderFollowUpsEditList();
      var addFuBtn = card.querySelector('.edit-add-followup-btn');
      if (addFuBtn) {
        addFuBtn.addEventListener('click', function() {
          followUpsData.push({ date: getTodayStr(), time: getCurrentTime(), content: '' });
          renderFollowUpsEditList();
        });
      }

      card.querySelector('.save-all-client-btn').onclick = async () => {
        var n = card.querySelector('.edit-name-input').value.trim();
        var p = card.querySelector('.edit-phone-input').value.trim();
        var comp = card.querySelector('.edit-company-input').value.trim();
        var fund = card.querySelector('.edit-fund-input').value.trim();
        var label = (card.querySelector('.edit-label-input')||{}).value||'';
        var nt = card.querySelector('.edit-note-input').value.trim();
        var newFollowUps = [];
        card.querySelectorAll('.edit-fu-content').forEach(function(el) {
          var content = el.value.trim();
          if (content) {
            var row = el.closest('.follow-up-edit-row');
            var fi = parseInt(row.dataset.fuidx);
            var existing = (fi >= 0 && fi < followUpsData.length) ? followUpsData[fi] : {};
            newFollowUps.push({
              date: existing.date || getTodayStr(),
              time: existing.time || getCurrentTime(),
              content: content
            });
          }
        });
        // Read new detail fields
        const age = (card.querySelector('.edit-age-input')||{}).value||''; const ageV = age.trim();
        const ms = (card.querySelector('.edit-marital-input')||{}).value||'';
        const sh = (card.querySelector('.edit-hukou-input')||{}).value||'';
        const ss = (card.querySelector('.edit-ss-input')||{}).value||''; const ssV = ss.trim();
        const as = (card.querySelector('.edit-salary-input')||{}).value||''; const asV = as.trim();
        const tx = (card.querySelector('.edit-tax-input')||{}).value||''; const txV = tx.trim();
        const sb = (card.querySelector('.edit-sbank-input')||{}).value||''; const sbV = sb.trim();
        const ed = (card.querySelector('.edit-edu-input')||{}).value||'';
        const pr = (card.querySelector('.edit-prop-input')||{}).value||'';
        const pt = (card.querySelector('.edit-proptype-input')||{}).value||'';
        const pa = (card.querySelector('.edit-propaddr-input')||{}).value||''; const paV = pa.trim();
        const pAr = (card.querySelector('.edit-proparea-input')||{}).value||''; const pArV = pAr.trim();
        const pmb = (card.querySelector('.edit-propmbank-input')||{}).value||''; const pmbV = pmb.trim();
        const pma = (card.querySelector('.edit-propmamt-input')||{}).value||''; const pmaV = pma.trim();
        const po = (card.querySelector('.edit-propother-input')||{}).value||''; const poV = po.trim();
        const bd = (card.querySelector('.edit-bankdebt-input')||{}).value||''; const bdV = bd.trim();
        const cd = (card.querySelector('.edit-ccdebt-input')||{}).value||''; const cdV = cd.trim();
        const q3 = (card.querySelector('.edit-query-input')||{}).value||''; const q3V = q3.trim();
        const ol = (card.querySelector('.edit-onlineloan-input')||{}).value||''; const olV = ol.trim();
        const dm = (card.querySelector('.edit-demand-input')||{}).value||''; const dmV = dm.trim();
        const fg = (card.querySelector('.edit-fusage-input')||{}).value||''; const fgV = fg.trim();
        const vt = (card.querySelector('.edit-visittime-input')||{}).value||''; const vtV = vt.trim();
        const stV = (card.querySelector('.edit-status-input')||{}).value||'';
        const ab = (card.querySelector('.edit-approvedbank-input')||{}).value||''; const abV = ab.trim();
        const aa = (card.querySelector('.edit-approvedamount-input')||{}).value||''; const aaV = aa.trim();
        const rt = (card.querySelector('.edit-rateterm-input')||{}).value||''; const rtV = rt.trim();
        const rb = (card.querySelector('.edit-rejectedbank-input')||{}).value||''; const rbV = rb.trim();
        const rr = (card.querySelector('.edit-rejectreason-input')||{}).value||''; const rrV = rr.trim();

        if (!n) { alert('姓名不能为空，请填写完整！'); return; }
        if (!p) { alert('电话号码不能为空，请填写完整！'); return; }
        if (!label) { alert('请选择客户等级（A/B/C 类），此项为必选！'); return; }
        if (!nt) { alert('沟通记录为必填项，请填写完整！'); return; }

        const allList = JSON.parse(localStorage.getItem(CLIENTS_K) || '[]');
        const idx = allList.findIndex(item => item.date === date && item.name === name && item.phone === phone &&
          (time ? item.time === time : true));
        const updatedClient = {
          date: date, time: c.time || getCurrentTime(),
          name: n, phone: p, company: comp, fund: fund, label: label, note: nt,
          followUps: newFollowUps,
          age: ageV, maritalStatus: ms, isShenzhenHukou: sh, socialSecurity: ssV,
          avgSalary: asV, tax2yr: txV, salaryBank: sbV, education: ed, property: pr,
          propertyType: pt, propertyAddress: paV, propertyArea: pArV, propertyMortgageBank: pmbV, propertyMortgageAmount: pmaV, propertyOther: poV,
          bankDebt: bdV, creditCardDebt: cdV, query3m: q3V, onlineLoanCount: olV,
          demand: dmV, fundUsage: fgV,
          visitTime: vtV, status: stV, approvedBank: abV, approvedAmount: aaV,
          rateTerm: rtV, rejectedBank: rbV, rejectReason: rrV
        };
        if (idx !== -1) { allList[idx] = updatedClient; }
        else { allList.push(updatedClient); }
        localStorage.setItem(CLIENTS_K, JSON.stringify(allList));

        await syncOp('updateClient', { matchName: name, matchPhone: phone, matchTime: c.time || '', client: updatedClient }, date);

        loadAllClients();
        renderClientList();
        refreshAll();
      };

      // Bind Cancel
      card.querySelector('.cancel-all-client-btn').onclick = () => { loadAllClients(); };
    }));
  }

  function initAllClientsBtn() {
    const allClientsBtn = document.getElementById('allClientsBtn');
    if (allClientsBtn) {
      allClientsBtn.addEventListener('click', () => {
        loadAllClients();
        const modal = document.getElementById('allClientsModal');
        if (modal) modal.classList.add('active');
      });
    }
    const closeBtn = document.getElementById('closeAllClientsModalBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        const modal = document.getElementById('allClientsModal');
        if (modal) modal.classList.remove('active');
      });
    }
    const modal = document.getElementById('allClientsModal');
    if (modal) {
      modal.addEventListener('click', e => {
        if (e.target === modal) {
          modal.classList.remove('active');
        }
      });
    }

    const addBtn = document.getElementById('allClientsAddBtn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        if (document.getElementById('newClientCard')) return;
        const container = document.getElementById('allClientsCardList');
        if (!container) return;

        const card = document.createElement('div');
        card.id = 'newClientCard';
        card.className = 'client-card-item all-client-card';
        card.style.border = '2px dashed var(--accent-wechat)';
        card.innerHTML =
          '<div class="client-card-top">' +
            '<span style="font-size:0.8rem;font-weight:600;color:var(--accent-wechat);">新增意向客户</span>' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="date" class="input-simple new-date-input" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;" value="' + getTodayStr() + '">' +
            '<input type="text" class="input-simple new-name-input" placeholder="姓名" autocomplete="off" readonly onfocus="this.removeAttribute(\\'readonly\\');" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.8rem;font-weight:400;">' +
            '<input type="text" class="input-simple new-phone-input" placeholder="电话" autocomplete="off" readonly onfocus="this.removeAttribute(\\'readonly\\');" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.8rem;">' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple new-company-input" placeholder="单位" autocomplete="off" style="flex:2;min-width:120px;padding:6px 8px;font-size:0.78rem;">' +
            '<input type="text" class="input-simple new-fund-input" placeholder="公积金基数" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;">' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<select class="input-simple input-select new-label-input" required style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;height:auto;border:1.5px solid var(--card-border);"><option value="">客户等级 *</option><option value="A">A 类 — 重点跟进</option><option value="B">B 类 — 常规跟进</option><option value="C">C 类 — 低优先级</option></select>' +
            '<span style="flex:1;"></span>' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple new-age-input" placeholder="年龄" autocomplete="off" style="flex:1;min-width:60px;padding:6px 8px;font-size:0.78rem;">' +
            '<select class="input-simple input-select new-marital-input" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">婚姻状况</option><option value="未婚">未婚</option><option value="已婚">已婚</option><option value="离异">离异</option><option value="丧偶">丧偶</option></select>' +
            '<select class="input-simple input-select new-hukou-input" style="flex:1;min-width:70px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">是否深户</option><option value="是">是</option><option value="否">否</option></select>' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple new-ss-input" placeholder="社保养老基数" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;">' +
            '<input type="text" class="input-simple new-salary-input" placeholder="月均工资" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;">' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple new-tax-input" placeholder="近2年个税" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;">' +
            '<input type="text" class="input-simple new-sbank-input" placeholder="代发工资银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;">' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<select class="input-simple input-select new-edu-input" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">学历</option><option value="初中及以下">初中及以下</option><option value="高中">高中</option><option value="大专">大专</option><option value="本科">本科</option><option value="硕士">硕士</option><option value="博士">博士</option></select>' +
            '<select class="input-simple input-select new-prop-input" style="flex:1;min-width:70px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">房产</option><option value="无房">无房</option><option value="有一套">有一套</option><option value="有多套">有多套</option></select>' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<select class="input-simple input-select new-proptype-input" style="flex:1;min-width:90px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">深房/外地房</option><option value="深房">深房</option><option value="外地房">外地房</option></select>' +
            '<input type="text" class="input-simple new-proparea-input" placeholder="面积" autocomplete="off" style="flex:1;min-width:70px;padding:6px 8px;font-size:0.78rem;">' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple new-propaddr-input" placeholder="房产地址" autocomplete="off" style="flex:1;min-width:120px;padding:6px 8px;font-size:0.78rem;">' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple new-propmbank-input" placeholder="抵押银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;">' +
            '<input type="text" class="input-simple new-propmamt-input" placeholder="还欠多少" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;">' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple new-propother-input" placeholder="房产其他情况" autocomplete="off" style="flex:1;min-width:120px;padding:6px 8px;font-size:0.78rem;">' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple new-bankdebt-input" placeholder="银行信贷负债" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;">' +
            '<input type="text" class="input-simple new-ccdebt-input" placeholder="信用卡负债" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;">' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple new-query-input" placeholder="近3个月查询次数" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;">' +
            '<input type="text" class="input-simple new-onlineloan-input" placeholder="小额网贷笔数" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;">' +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<input type="text" class="input-simple new-visittime-input" placeholder="上门办理时间" autocomplete="off" style="flex:1;min-width:120px;padding:6px 8px;font-size:0.78rem;">' +
            '<select class="input-simple input-select new-status-input" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;height:auto;"><option value="">状态</option><option value="success">已办理成功</option><option value="failed">未办理成功</option></select>' +
          '</div>' +
          '<div class="new-success-fields" style="display:none;flex-direction:column;gap:8px;">' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple new-approvedbank-input" placeholder="批款银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;">' +
              '<input type="text" class="input-simple new-approvedamount-input" placeholder="批款金额" autocomplete="off" style="flex:1;min-width:80px;padding:6px 8px;font-size:0.78rem;">' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple new-rateterm-input" placeholder="利率年限" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;">' +
              '<span style="flex:1;"></span>' +
            '</div>' +
          '</div>' +
          '<div class="new-failed-fields" style="display:none;flex-direction:column;gap:8px;">' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<input type="text" class="input-simple new-rejectedbank-input" placeholder="拒绝银行" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;">' +
              '<input type="text" class="input-simple new-rejectreason-input" placeholder="拒绝原因" autocomplete="off" style="flex:1;min-width:100px;padding:6px 8px;font-size:0.78rem;">' +
            '</div>' +
          '</div>' +
          '<textarea class="input-simple new-demand-input" placeholder="客户大致需求" style="width:100%;min-height:50px;padding:8px;font-size:0.78rem;resize:vertical;box-sizing:border-box;"></textarea>' +
          '<textarea class="input-simple new-fusage-input" placeholder="资金用途和时间" style="width:100%;min-height:50px;padding:8px;font-size:0.78rem;resize:vertical;box-sizing:border-box;"></textarea>' +
          '<textarea class="input-simple new-note-input" placeholder="沟通记录（必填）" style="width:100%;min-height:70px;padding:8px;font-size:0.78rem;resize:vertical;box-sizing:border-box;"></textarea>' +
          '<textarea class="input-simple new-follow-input" placeholder="跟进情况" style="width:100%;min-height:60px;padding:8px;font-size:0.78rem;resize:vertical;box-sizing:border-box;"></textarea>' +
          '<div style="display:flex;justify-content:flex-end;gap:8px;border-top:1px dashed var(--card-border);padding-top:8px;">' +
            '<button class="save-new-client-btn btn-add" style="font-size:0.75rem;padding:6px 16px;background:var(--accent-btn);color:white;border:none;border-radius:6px;font-weight:700;">保存</button>' +
            '<button class="cancel-new-client-btn btn-add" style="font-size:0.75rem;padding:6px 16px;background:var(--btn-bg);color:var(--text-soft);border:1px solid var(--card-border);border-radius:6px;font-weight:700;">取消</button>' +
          '</div>';

        container.insertBefore(card, container.firstChild);
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });

        card.querySelector('.new-status-input').addEventListener('change', function() {
          var sf = card.querySelector('.new-success-fields');
          var ff = card.querySelector('.new-failed-fields');
          if (sf) sf.style.display = this.value === 'success' ? 'flex' : 'none';
          if (ff) ff.style.display = this.value === 'failed' ? 'flex' : 'none';
        });

        card.querySelector('.save-new-client-btn').onclick = async () => {
          const d = card.querySelector('.new-date-input').value.trim();
          const n = card.querySelector('.new-name-input').value.trim();
          const p = card.querySelector('.new-phone-input').value.trim();
          const comp = card.querySelector('.new-company-input').value.trim();
          const fund = card.querySelector('.new-fund-input').value.trim();
          const label = (card.querySelector('.new-label-input')||{}).value||'';
          const nt = card.querySelector('.new-note-input').value.trim();
          const fu = card.querySelector('.new-follow-input').value.trim();
          // Read new detail fields
          const age = (card.querySelector('.new-age-input')||{}).value||''; const ageV = age.trim();
          const ms = (card.querySelector('.new-marital-input')||{}).value||'';
          const sh = (card.querySelector('.new-hukou-input')||{}).value||'';
          const ss = (card.querySelector('.new-ss-input')||{}).value||''; const ssV = ss.trim();
          const as = (card.querySelector('.new-salary-input')||{}).value||''; const asV = as.trim();
          const tx = (card.querySelector('.new-tax-input')||{}).value||''; const txV = tx.trim();
          const sb = (card.querySelector('.new-sbank-input')||{}).value||''; const sbV = sb.trim();
          const ed = (card.querySelector('.new-edu-input')||{}).value||'';
          const pr = (card.querySelector('.new-prop-input')||{}).value||'';
          const pt = (card.querySelector('.new-proptype-input')||{}).value||'';
          const pa = (card.querySelector('.new-propaddr-input')||{}).value||''; const paV = pa.trim();
          const pAr = (card.querySelector('.new-proparea-input')||{}).value||''; const pArV = pAr.trim();
          const pmb = (card.querySelector('.new-propmbank-input')||{}).value||''; const pmbV = pmb.trim();
          const pma = (card.querySelector('.new-propmamt-input')||{}).value||''; const pmaV = pma.trim();
          const po = (card.querySelector('.new-propother-input')||{}).value||''; const poV = po.trim();
          const bd = (card.querySelector('.new-bankdebt-input')||{}).value||''; const bdV = bd.trim();
          const cd = (card.querySelector('.new-ccdebt-input')||{}).value||''; const cdV = cd.trim();
          const q3 = (card.querySelector('.new-query-input')||{}).value||''; const q3V = q3.trim();
          const ol = (card.querySelector('.new-onlineloan-input')||{}).value||''; const olV = ol.trim();
          const dm = (card.querySelector('.new-demand-input')||{}).value||''; const dmV = dm.trim();
          const fg = (card.querySelector('.new-fusage-input')||{}).value||''; const fgV = fg.trim();
          const vt = (card.querySelector('.new-visittime-input')||{}).value||''; const vtV = vt.trim();
          const stV = (card.querySelector('.new-status-input')||{}).value||'';
          const ab = (card.querySelector('.new-approvedbank-input')||{}).value||''; const abV = ab.trim();
          const aa = (card.querySelector('.new-approvedamount-input')||{}).value||''; const aaV = aa.trim();
          const rt = (card.querySelector('.new-rateterm-input')||{}).value||''; const rtV = rt.trim();
          const rb = (card.querySelector('.new-rejectedbank-input')||{}).value||''; const rbV = rb.trim();
          const rr = (card.querySelector('.new-rejectreason-input')||{}).value||''; const rrV = rr.trim();

          if (!d) { alert('请选择日期！'); return; }
          if (!n) { alert('姓名不能为空，请填写完整！'); return; }
          if (!p) { alert('电话号码不能为空，请填写完整！'); return; }
          if (!label) { alert('请选择客户等级（A/B/C 类），此项为必选！'); return; }
          if (!nt) { alert('沟通记录为必填项，请填写完整！'); return; }

          const newClient = { name: n, phone: p, company: comp, fund: fund, label: label, note: nt, followUps: fu ? [{ date: d, time: getCurrentTime(), content: fu }] : [], date: d, time: getCurrentTime(),
            age: ageV, maritalStatus: ms, isShenzhenHukou: sh, socialSecurity: ssV,
            avgSalary: asV, tax2yr: txV, salaryBank: sbV, education: ed, property: pr,
            propertyType: pt, propertyAddress: paV, propertyArea: pArV, propertyMortgageBank: pmbV, propertyMortgageAmount: pmaV, propertyOther: poV,
            bankDebt: bdV, creditCardDebt: cdV, query3m: q3V, onlineLoanCount: olV,
            demand: dmV, fundUsage: fgV,
            visitTime: vtV, status: stV, approvedBank: abV, approvedAmount: aaV,
            rateTerm: rtV, rejectedBank: rbV, rejectReason: rrV };

          const allList = JSON.parse(localStorage.getItem(CLIENTS_K) || '[]');
          allList.push(newClient);
          localStorage.setItem(CLIENTS_K, JSON.stringify(allList));

          const countForDate = allList.filter(c => c.date === d).length;
          const im = loadMap(INTENT_K);
          im[d] = countForDate;
          saveMap(INTENT_K, im);

          await syncOp('addClient', { client: newClient }, d);

          loadAllClients();
          renderClientList();
          refreshAll();
        };

        card.querySelector('.cancel-new-client-btn').onclick = () => { loadAllClients(); };
      });
    }

    // 全量意向模糊搜索
    const searchInput = document.getElementById('allClientsSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', function() {
        const q = this.value.trim().toLowerCase();
        if (!q) { renderAllClientsCards(_allClientsCache); return; }
        const filtered = _allClientsCache.filter(function(c) {
          return (c.name||'').toLowerCase().includes(q) ||
            (c.phone||'').toLowerCase().includes(q) ||
            (c.company||'').toLowerCase().includes(q);
        });
        renderAllClientsCards(filtered);
      });
    }

    // 全量意向排序
    const sortSelect = document.getElementById('allClientsSortSelect');
    const sortOrderBtn = document.getElementById('allClientsSortOrderBtn');
    function updateSortOrderBtn() {
      if (sortOrderBtn) {
        sortOrderBtn.textContent = _allClientsSortAsc ? '↑' : '↓';
      }
    }
    function applySort() {
      const q = (searchInput && searchInput.value || '').trim().toLowerCase();
      var source = _allClientsCache;
      if (q) {
        source = _allClientsCache.filter(function(c) {
          return (c.name||'').toLowerCase().includes(q) ||
            (c.phone||'').toLowerCase().includes(q) ||
            (c.company||'').toLowerCase().includes(q);
        });
      }
      renderAllClientsCards(source);
    }
    if (sortSelect) {
      sortSelect.value = _allClientsSortField;
      sortSelect.addEventListener('change', function() {
        _allClientsSortField = this.value;
        applySort();
      });
    }
    if (sortOrderBtn) {
      updateSortOrderBtn();
      sortOrderBtn.addEventListener('click', function() {
        _allClientsSortAsc = !_allClientsSortAsc;
        updateSortOrderBtn();
        applySort();
      });
    }
  }

  function initLoanCalc() {
    const LOAN_CALC_K = 'loan_calc_v1';
    function loadState() {
      try { return JSON.parse(localStorage.getItem(LOAN_CALC_K)) || {}; } catch(e) { return {}; }
    }
    function saveState(state) {
      localStorage.setItem(LOAN_CALC_K, JSON.stringify(state));
    }

    // === Core Calculation Functions ===
    function calcDEBX(P, rate, n, rateMode) {
      var r = rateMode === 'annual' ? rate / 100 / 12 : rate / 100;
      var mp, total, interest, schedule = [];
      if (r === 0) {
        mp = n > 0 ? P / n : P;
        total = P;
        interest = 0;
        var rem = P;
        for (var i = 0; i < n; i++) {
          rem -= mp;
          schedule.push({ period: i + 1, payment: mp, interest: 0, principal: mp, remaining: Math.max(0, rem) });
        }
      } else {
        var pow = Math.pow(1 + r, n);
        mp = P * r * pow / (pow - 1);
        total = mp * n;
        interest = total - P;
        var remaining = P;
        for (var j = 0; j < n; j++) {
          var intPart = remaining * r;
          var prinPart = mp - intPart;
          remaining -= prinPart;
          schedule.push({ period: j + 1, payment: mp, interest: intPart, principal: prinPart, remaining: Math.max(0, remaining) });
        }
      }
      return { totalInterest: interest, totalRepayment: total, monthlyPayment: mp, interestRatio: total > 0 ? (interest / total) * 100 : 0, schedule: schedule };
    }

    function calcXXHB(P, rate, n, rateMode) {
      var r = rateMode === 'annual' ? rate / 100 / 12 : rate / 100;
      var monthlyInt = P * r;
      var totalInterest = monthlyInt * n;
      var totalRepayment = P + totalInterest;
      var schedule = [];
      for (var i = 0; i < n; i++) {
        if (i < n - 1) {
          schedule.push({ period: i + 1, payment: monthlyInt, interest: monthlyInt, principal: 0, remaining: P });
        } else {
          schedule.push({ period: i + 1, payment: monthlyInt + P, interest: monthlyInt, principal: P, remaining: 0 });
        }
      }
      return { totalInterest: totalInterest, totalRepayment: totalRepayment, monthlyPayment: monthlyInt, interestRatio: totalRepayment > 0 ? (totalInterest / totalRepayment) * 100 : 0, schedule: schedule };
    }

    function calcSJJH(P, rate, termMonths, rateMode, days) {
      var d = days || 30;
      var monthlyRate = rateMode === 'annual' ? rate / 100 / 12 : rate / 100;
      var dailyRate = monthlyRate / 30;
      var totalInterest = P * dailyRate * d;
      var totalRepayment = P + totalInterest;
      var avgDaily = d > 0 ? totalInterest / d : 0;
      return { totalInterest: totalInterest, totalRepayment: totalRepayment, monthlyPayment: avgDaily, interestRatio: totalRepayment > 0 ? (totalInterest / totalRepayment) * 100 : 0, schedule: [{ period: 1, payment: totalRepayment, interest: totalInterest, principal: P, remaining: 0 }] };
    }

    function fmt(v) {
      return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function pct(v) {
      return v.toFixed(2) + '%';
    }

    function getInputs() {
      var principal = parseFloat(document.getElementById('loanPrincipal').value) || 0;
      var monthlyRate = parseFloat(document.getElementById('loanMonthlyRate').value) || 0;
      var term = parseInt(document.getElementById('loanTerm').value) || 1;
      var days = parseInt(document.getElementById('loanDays').value) || 30;
      var rateSpread = parseFloat(document.getElementById('loanRateSpread').value) || 0;
      var financeCost = parseFloat(document.getElementById('loanFinanceCost').value) || 0;
      var methodEl = document.querySelector('.loan-tab.active');
      var method = methodEl ? methodEl.dataset.method : 'debx';
      return { principal: principal, rate: monthlyRate, rateMode: 'monthly', term: term, days: days, method: method, rateSpread: rateSpread, financeCost: financeCost };
    }

    var methods = [
      { id: 'debx', name: '等额本息', fn: calcDEBX },
      { id: 'xxhb', name: '先息后本', fn: calcXXHB },
      { id: 'sjjh', name: '随借随还', fn: calcSJJH }
    ];

    function updateResultCards(result, method) {
      document.getElementById('loanTotalInterest').textContent = '￥' + fmt(result.totalInterest);
      document.getElementById('loanTotalRepayment').textContent = '￥' + fmt(result.totalRepayment);
      var payLabel = document.getElementById('loanMonthlyLabel');
      var payVal = document.getElementById('loanMonthlyPayment');
      if (method === 'sjjh') {
        payLabel.textContent = '日均利息';
        payVal.textContent = '￥' + fmt(result.monthlyPayment);
      } else {
        payLabel.textContent = '月供';
        payVal.textContent = '￥' + fmt(result.monthlyPayment);
      }
      document.getElementById('loanInterestRatio').textContent = pct(result.interestRatio);
    }

    function updateSpreadCards(baseResult, spreadResult, method, principal) {
      var spreadEl = document.getElementById('loanSpreadResults');
      if (!spreadResult) {
        if (spreadEl) spreadEl.style.display = 'none';
        return;
      }
      if (spreadEl) spreadEl.style.display = '';
      var diffTotal = spreadResult.totalRepayment - baseResult.totalRepayment;
      document.getElementById('loanSpreadMonthly').textContent = '￥' + fmt(Math.max(0, spreadResult.monthlyPayment - baseResult.monthlyPayment));
      document.getElementById('loanSpreadTotal').textContent = '￥' + fmt(Math.max(0, diffTotal));
      var pctVal = principal > 0 ? (diffTotal / principal * 100) : 0;
      document.getElementById('loanSpreadPct').textContent = pct(pctVal);
    }

    function buildComparisonTable(P, rate, term, rateMode, days) {
      var activeMethodEl = document.querySelector('.loan-tab.active');
      var activeMethod = activeMethodEl ? activeMethodEl.dataset.method : 'debx';
      var html = '<table class="loan-compare-table"><thead><tr><th>还款方式</th><th>月供/日均</th><th>总利息</th><th>总还款</th><th>利息占比</th></tr></thead><tbody>';
      methods.forEach(function(m) {
        var r = m.fn(P, rate, term, rateMode, days);
        var cls = m.id === activeMethod ? ' highlight' : '';
        html += '<tr class="' + cls + '"><td>' + esc(m.name) + '</td><td>' + esc(fmt(r.monthlyPayment)) + '</td><td>' + esc(fmt(r.totalInterest)) + '</td><td>' + esc(fmt(r.totalRepayment)) + '</td><td>' + esc(pct(r.interestRatio)) + '</td></tr>';
      });
      html += '</tbody></table>';
      return html;
    }

    function buildScheduleTable(schedule) {
      if (!schedule || schedule.length === 0) return '<div style="text-align:center;color:var(--text-light);padding:20px;font-size:0.75rem;">输入参数后生成还款计划</div>';
      var html = '<div class="loan-schedule-wrap"><table class="loan-schedule-table"><thead><tr><th>期次</th><th>还款金额</th><th>利息</th><th>本金</th><th>剩余本金</th></tr></thead><tbody>';
      schedule.forEach(function(row) {
        html += '<tr><td>' + row.period + '</td><td>' + esc(fmt(row.payment)) + '</td><td>' + esc(fmt(row.interest)) + '</td><td>' + esc(fmt(row.principal)) + '</td><td>' + esc(fmt(Math.max(0, row.remaining))) + '</td></tr>';
      });
      html += '</tbody></table></div>';
      return html;
    }

    function renderLoanCalc() {
      var inp = getInputs();
      saveState(inp);
      // 月息单位提示：输入年化自动同步月息时，直接显示厘（月息% × 10 = 厘）
      var liEl = document.getElementById('loanMonthlyUnit');
      if (liEl) liEl.textContent = inp.rate > 0 ? '≈' + (inp.rate * 10).toFixed(1) + '厘' : '% / 月';
      // 月息差单位提示：同样显示厘
      var lsEl = document.getElementById('loanRateSpreadUnit');
      if (lsEl) lsEl.textContent = inp.rateSpread > 0 ? '≈' + (inp.rateSpread * 10).toFixed(1) + '厘' : '% / 月';
      if (inp.principal <= 0 || inp.rate <= 0) {
        document.getElementById('loanTotalInterest').textContent = '--';
        document.getElementById('loanTotalRepayment').textContent = '--';
        document.getElementById('loanMonthlyPayment').textContent = '--';
        document.getElementById('loanInterestRatio').textContent = '--';
        document.getElementById('loanSpreadResults').style.display = 'none';
        document.getElementById('loanFinanceResults').style.display = 'none';
        document.getElementById('loanComparisonContainer').innerHTML = '';
        document.getElementById('loanScheduleContainer').innerHTML = '';
        return;
      }
      var activeMethod = inp.method;
      var activeFn = null;
      methods.forEach(function(m) { if (m.id === activeMethod) activeFn = m.fn; });
      if (activeFn) {
        var result = activeFn(inp.principal, inp.rate, inp.term, inp.rateMode, inp.days);
        updateResultCards(result, activeMethod);
        document.getElementById('loanScheduleContainer').innerHTML = buildScheduleTable(result.schedule);

        // 月息差计算
        var spreadExtra = 0; // 总多还金额（实际月息更高时多还的总额）
        if (inp.rateSpread > 0) {
          var higherRate = inp.rate + inp.rateSpread;
          var spreadResult = activeFn(inp.principal, higherRate, inp.term, inp.rateMode, inp.days);
          spreadExtra = Math.max(0, spreadResult.totalRepayment - result.totalRepayment);
          updateSpreadCards(result, spreadResult, activeMethod, inp.principal);
        } else {
          document.getElementById('loanSpreadResults').style.display = 'none';
        }

        // 融资成本：全部成本 = 服务费金额 + 成本总金额；实际到账 = 本金 − 全部成本
        if (inp.financeCost > 0 || spreadExtra > 0) {
          var costAmount = inp.principal * inp.financeCost / 100;
          var totalCost = costAmount + spreadExtra;
          var costPct = inp.principal > 0 ? (totalCost / inp.principal * 100) : 0;
          var netReceived = inp.principal - totalCost;
          document.getElementById('loanFinanceResults').style.display = '';
          document.getElementById('loanFinanceAmount').textContent = '￥' + fmt(costAmount);
          document.getElementById('loanSpreadExtraAmount').textContent = '￥' + fmt(spreadExtra);
          document.getElementById('loanTotalCost').textContent = '￥' + fmt(totalCost);
          document.getElementById('loanCostPct').textContent = pct(costPct);
          document.getElementById('loanNetReceived').textContent = '￥' + fmt(Math.max(0, netReceived));
        } else {
          document.getElementById('loanFinanceResults').style.display = 'none';
        }
      }
      document.getElementById('loanComparisonContainer').innerHTML = buildComparisonTable(inp.principal, inp.rate, inp.term, inp.rateMode, inp.days);
    }

    // === Modal & Event Bindings ===
    var modal = document.getElementById('loanModal');
    var closeBtn = document.getElementById('closeLoanModalBtn');

    function openLoanCalc() {
      var state = loadState();
      var principalEl = document.getElementById('loanPrincipal');
      if (principalEl && state.principal) principalEl.value = state.principal;
      var mRateEl = document.getElementById('loanMonthlyRate');
      if (mRateEl && state.rate) mRateEl.value = state.rate;
      // Auto-sync annual rate
      var aRateEl = document.getElementById('loanAnnualRate');
      if (aRateEl && state.rate) aRateEl.value = (state.rate * 12).toFixed(4);
      var termEl = document.getElementById('loanTerm');
      if (termEl && state.term) {
        // 下拉框只含 12/24/36/60/84：保存的旧值不在列表时回退到第一项
        var termOpt = termEl.querySelector('option[value="' + state.term + '"]');
        termEl.value = termOpt ? state.term : (termEl.options[0] ? termEl.options[0].value : '12');
      }
      var daysEl = document.getElementById('loanDays');
      if (daysEl && state.days) daysEl.value = state.days;
      var spreadEl = document.getElementById('loanRateSpread');
      if (spreadEl && state.rateSpread) spreadEl.value = state.rateSpread;
      var financeEl = document.getElementById('loanFinanceCost');
      if (financeEl && state.financeCost) financeEl.value = state.financeCost;
      if (state.method) {
        document.querySelectorAll('.loan-tab').forEach(function(t) {
          t.classList.toggle('active', t.dataset.method === state.method);
        });
        document.getElementById('loanDaysField').classList.toggle('visible', state.method === 'sjjh');
      }
      renderLoanCalc();
      modal.classList.add('active');
    }

    // Open from menu
    var menuBtn = document.getElementById('loanCalcBtn');
    if (menuBtn) {
      menuBtn.addEventListener('click', function() { openLoanCalc(); });
    }

    closeBtn.addEventListener('click', function() { modal.classList.remove('active'); });
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.classList.remove('active'); });

    // Tab switching
    document.querySelectorAll('.loan-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        document.querySelectorAll('.loan-tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        document.getElementById('loanDaysField').classList.toggle('visible', tab.dataset.method === 'sjjh');
        renderLoanCalc();
      });
    });

    // 月息 → 年化 自动同步 (×12)
    var monthlyRateEl = document.getElementById('loanMonthlyRate');
    var annualRateEl = document.getElementById('loanAnnualRate');
    var syncing = false;
    if (monthlyRateEl) {
      monthlyRateEl.addEventListener('input', function() {
        if (syncing) return;
        syncing = true;
        var monthlyVal = parseFloat(monthlyRateEl.value) || 0;
        if (annualRateEl) annualRateEl.value = (monthlyVal * 12).toFixed(4);
        syncing = false;
        renderLoanCalc();
      });
    }
    // 年化 → 月息 自动同步 (÷12)
    if (annualRateEl) {
      annualRateEl.addEventListener('input', function() {
        if (syncing) return;
        syncing = true;
        var annualVal = parseFloat(annualRateEl.value) || 0;
        if (monthlyRateEl) monthlyRateEl.value = (annualVal / 12).toFixed(4);
        syncing = false;
        renderLoanCalc();
      });
    }

    // Auto-recalc on input change
    ['loanPrincipal', 'loanMonthlyRate', 'loanAnnualRate', 'loanTerm', 'loanDays', 'loanRateSpread', 'loanFinanceCost'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', renderLoanCalc);
        el.addEventListener('change', renderLoanCalc); // 贷款期限下拉框走 change 事件
      }
    });

    // 复制结果：以"类目：数字"文本形式导出（不含还款计划明细）
    function buildLoanResultText() {
      var inp = getInputs();
      if (inp.principal <= 0 || inp.rate <= 0) return '';
      var lines = [];
      lines.push('贷款金额：￥' + fmt(inp.principal));
      lines.push('月息：' + inp.rate + '%（' + (inp.rate * 10).toFixed(1) + '厘）');
      var aEl = document.getElementById('loanAnnualRate');
      if (aEl && aEl.value) lines.push('年化利率：' + aEl.value.trim() + '%');
      var tEl = document.getElementById('loanTerm');
      if (tEl && tEl.value) lines.push('贷款期限：' + tEl.value + '个月');
      var mEl = document.querySelector('.loan-tab.active');
      if (mEl) lines.push('还款方式：' + mEl.textContent);
      lines.push('');
      var labelEl = document.getElementById('loanMonthlyLabel');
      var payEl = document.getElementById('loanMonthlyPayment');
      if (payEl && payEl.textContent !== '--') lines.push((labelEl ? labelEl.textContent : '月供') + '：' + payEl.textContent);
      var ti = document.getElementById('loanTotalInterest');
      if (ti && ti.textContent !== '--') lines.push('总利息：' + ti.textContent);
      var tr = document.getElementById('loanTotalRepayment');
      if (tr && tr.textContent !== '--') lines.push('总还款：' + tr.textContent);
      var ir = document.getElementById('loanInterestRatio');
      if (ir && ir.textContent !== '--') lines.push('利息占比：' + ir.textContent);
      var sEl = document.getElementById('loanSpreadResults');
      if (sEl && sEl.style.display !== 'none') {
        lines.push('');
        var sm = document.getElementById('loanSpreadMonthly');
        var sp = document.getElementById('loanSpreadPct');
        if (sm && sm.textContent !== '--') lines.push('分摊成本：' + sm.textContent);
        if (sp && sp.textContent !== '--') lines.push('成本占比：' + sp.textContent);
      }
      var fEl = document.getElementById('loanFinanceResults');
      if (fEl && fEl.style.display !== 'none') {
        lines.push('');
        var f1 = document.getElementById('loanFinanceAmount');
        var f2 = document.getElementById('loanSpreadExtraAmount');
        var f3 = document.getElementById('loanTotalCost');
        var f4 = document.getElementById('loanCostPct');
        var f5 = document.getElementById('loanNetReceived');
        if (f1) lines.push('服务费金额：' + f1.textContent);
        if (f2) lines.push('成本总金额：' + f2.textContent);
        if (f3) lines.push('全部成本：' + f3.textContent);
        if (f4) lines.push('全部成本占比：' + f4.textContent);
        if (f5) lines.push('实际到账：' + f5.textContent);
      }
      return lines.join('\\n');
    }
    function copyLoanTextFallback(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
    }
    var copyBtn = document.getElementById('copyLoanResultBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        var text = buildLoanResultText();
        if (!text) return;
        var done = function() { copyBtn.textContent = '已复制'; setTimeout(function() { copyBtn.textContent = '复制结果'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(function() { copyLoanTextFallback(text); done(); });
        } else { copyLoanTextFallback(text); done(); }
      });
    }

  }

  function safeInit(name, fn) { try { fn(); } catch (e) { console.error('Init error: ' + name, e); } }
  safeInit('initAndroid', initAndroid);
  safeInit('initLogs', initLogs);
  safeInit('initDark', initDark);
  safeInit('initWp', initWp);
  safeInit('initScriptFeature', initScriptFeature);
  safeInit('initLearnFeature', initLearnFeature);
  safeInit('initExport', initExport);
  safeInit('initAllClientsBtn', initAllClientsBtn);
  safeInit('initGoals', initGoals);
  safeInit('initWhitelistFeature', initWhitelistFeature);
  safeInit('initLoanCalc', initLoanCalc);
  function initKeyQuestions(){
    var el1=document.getElementById('keyQuestionsIntent');
    var el2=document.getElementById('keyQuestionsTemp');
    if(el1)el1.innerHTML=renderKeyQuestionsHTML('kq_',[]);
    if(el2)el2.innerHTML=renderKeyQuestionsHTML('tkq_',[]);
  }
  safeInit('initKeyQuestions', initKeyQuestions);
  document.getElementById('goalEyeBtn').addEventListener('click',toggleGoalNumbers);
  function calGo(delta){
    const [y,m]=calendarMonth.split('-').map(Number);
    const d=new Date(y,m-1+delta,1);
    calendarMonth=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    syncCalendarFromCloud().then(()=>refreshAll());
  }
  document.getElementById('calPrevBtn').addEventListener('click',()=>calGo(-1));
  document.getElementById('calNextBtn').addEventListener('click',()=>calGo(1));
  // 菜单下拉
  (function(){
    const toggle=document.getElementById('menuToggleBtn');
    const dropdown=document.getElementById('menuDropdown');
    toggle.addEventListener('click',e=>{e.stopPropagation();dropdown.classList.toggle('show');});
    document.addEventListener('click',e=>{if(!dropdown.contains(e.target)&&e.target!==toggle)dropdown.classList.remove('show');});
    dropdown.querySelectorAll('.menu-item').forEach(item=>item.addEventListener('click',()=>dropdown.classList.remove('show')));
  })();
  const UNLOCK_TS_K='unlock_ts';
  (function(){
    // 同步判断：本地有 token 且未锁 → 立即显示对应界面，消除刷新闪烁
    var hasToken=!!localStorage.getItem(AUTH_TOKEN_K);
    var unlocked=(Date.now()-parseInt(localStorage.getItem(UNLOCK_TS_K)||'0'))<3600000;
    if(hasToken && unlocked){
      showJournalShell();localStorage.setItem(LOCK_K,'false');
    }
    // 后台异步验证 token 有效性
    checkAuth().then(function(valid){
      if(!valid && hasToken){
        // token 失效，清除并锁屏
        localStorage.removeItem(AUTH_TOKEN_K);
        localStorage.removeItem(AUTH_USER_K);
        document.body.className='page-hidden';
      }
    });
  })();
  (async function(){
    // 异步补充：无 token 时检查并显示锁屏或旧界面
    if(!localStorage.getItem(AUTH_TOKEN_K)){
      var unlocked=(Date.now()-parseInt(localStorage.getItem(UNLOCK_TS_K)||'0'))<3600000;
      if(unlocked){setLocked(false);}else{setLocked(true);}
    }
    initWp();
    var _savedUntil=parseInt(localStorage.getItem('pin_lockout_until')||'0');
    if(_savedUntil>Date.now()){setTimeout(function(){startPinCooldown(Math.ceil((_savedUntil-Date.now())/1000));},200);}
    // 首次加载：先补发上次未完成的操作，再从云端拉取最新状态
    (async()=>{
    try {
      // 1. 先补发上次关页前没有发成功的操作（Office 式离线队列）
      await drainQueue();
    } catch(e) { console.error('drainQueue error:', e); }

    try {
      // 2. 再拉取云端最新状态
      await loadFromCloud(getTodayStr());
    } catch(e) { console.error('loadFromCloud error:', e); }

    try {
      // 3. 拉取并同步全量云端客户数据
      await syncAllClientsFromCloud();
    } catch(e) { console.error('syncAllClients error:', e); }

    // 跨天自动转移昨日「明日待办」到今日
    const todayStr=getTodayStr();
    const prevLastLoadDate=localStorage.getItem(LAST_LOAD_DATE_K);
    if(prevLastLoadDate && prevLastLoadDate!==todayStr){
      let transferred=false;
      try{
        // 优先从前一天云端记录拉取 tomorrowTodos
        const yd=await cloudGet(prevLastLoadDate);
        if(yd && yd.tomorrowTodos && yd.tomorrowTodos.length>0){
          const cur=loadTodos(TODAY_TODO_K);
          const transferred2=yd.tomorrowTodos.map(t=>({...(typeof t==='string'?{text:t}:t),date:todayStr}));
          saveTodos(TODAY_TODO_K,[...transferred2,...cur]);
          saveTodos(TOMORROW_TODO_K,[]);
          transferred=true;
          console.log('📅 已从云端转移昨日待办到今日');
        }
      }catch(e){}
      if(!transferred){
        try {
          const tomorrow=loadTodos(TOMORROW_TODO_K);
          if(tomorrow.length>0){
            const cur=loadTodos(TODAY_TODO_K);
            const transferred3=tomorrow.map(t=>({...(typeof t==='string'?{text:t}:t),date:todayStr}));
            saveTodos(TODAY_TODO_K,[...transferred3,...cur]);
            saveTodos(TOMORROW_TODO_K,[]);
            console.log('📅 已转移本地昨日待办到今日');
          }
        } catch(e) {}
      }
    }
    localStorage.setItem(LAST_LOAD_DATE_K,todayStr);
    calendarMonth=getCurrentMonth();
    
    try {
      await syncCalendarFromCloud();
    } catch(e) { console.error('syncCalendar error:', e); }

    try {
      renderLockScripts();renderLockLearns();
    } catch(e) { console.error('renderLock error:', e); }

    refreshAll();
    startSyncTimer();
  })();
  })();
  // 账号认证 — 绑定按钮事件
  document.getElementById('authLoginBtn').addEventListener('click',function(){
    doLogin(document.getElementById('authUsername').value.trim(),document.getElementById('authPassword').value);
  });
  document.getElementById('authPassword').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin(document.getElementById('authUsername').value.trim(),document.getElementById('authPassword').value);});
  document.getElementById('authRegisterBtn').addEventListener('click',function(){
    doRegister(document.getElementById('authRegUsername').value.trim(),document.getElementById('authRegPassword').value,document.getElementById('authRegPassword2').value);
  });
  document.getElementById('authRegPassword2').addEventListener('keydown',function(e){if(e.key==='Enter')doRegister(document.getElementById('authRegUsername').value.trim(),document.getElementById('authRegPassword').value,document.getElementById('authRegPassword2').value);});
  document.getElementById('authSwitchRegister').addEventListener('click',function(){
    document.getElementById('authFormLogin').style.display='none';
    document.getElementById('authFormRegister').style.display='flex';
    document.getElementById('authError').innerText='';
    document.getElementById('authRegUsername').value=document.getElementById('authUsername').value;
    setTimeout(function(){document.getElementById('authRegUsername').focus();},100);
  });
  document.getElementById('authSwitchLogin').addEventListener('click',function(){
    document.getElementById('authFormRegister').style.display='none';
    document.getElementById('authFormLogin').style.display='flex';
    document.getElementById('authError').innerText='';
    document.getElementById('authUsername').value=document.getElementById('authRegUsername').value;
    setTimeout(function(){document.getElementById('authUsername').focus();},100);
  });

  setInterval(()=>{if(!document.body.classList.contains('page-hidden')&&!document.hidden)refreshAll();},60000);

  // 页面即将关闭时用 sendBeacon 兜底保存（keepalive 保证关闭后仍能发出）
  // 注意：不在 visibilitychange 时调用 saveFullState，避免设备 B 切标签时
  // 用陈旧的本地数据覆盖云端（设备 A 刚同步上去的数据）
  window.addEventListener('beforeunload',()=>{
    const today=getTodayStr();
    const wm=loadMap(WECHAT_K);
    const rm=loadMap(REVISIT_K);
    const vm=loadMap(VISIT_K);
    const pm=loadMap(PAYMENT_K);
    const allClients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const todayClients=allClients.filter(c=>c.date===today);
    const payload=JSON.stringify({
      date:today,
      wechatCount:wm[today]||0,
      intentCount:todayClients.length,
      revisitCount:rm[today]||0,
      visitCount:vm[today]||0,
      paymentCount:pm[today]||0,
      clients:todayClients,
      todayTodos:loadTodos(TODAY_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today),
      tomorrowTodos:loadTodos(TOMORROW_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today),
      tempClients:JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]'),
      scripts:loadScripts(),
      learns:loadLearns(),
      _ts:Date.now()
    });
    navigator.sendBeacon('/api/data',new Blob([payload],{type:'application/json'}));
  });
})();
  // 退出登录按钮
  var logoutBtn=document.getElementById('logoutMenuBtn');
  if(logoutBtn)logoutBtn.addEventListener('click',function(){if(confirm('确定要退出登录吗？'))doLogout();});
</script>
<!-- 蜜罐陷阱 — 爬虫会跟随，正常用户不可见 -->
<a href="/api/trap" style="display:none" aria-hidden="true" rel="nofollow"></a>
<div style="height:5px;width:100%;flex-shrink:0;" aria-hidden="true"></div>
</body>
</html>`;

    // ========== 内容管理 API（复制粘贴保留格式） ==========

    // 获取内容清单
    if (path === '/api/paste' && request.method === 'GET') {
      const manifest = await env.DATA_KV.get('pastes:manifest');
      let pastes = [];
      if (manifest) {
        try { pastes = JSON.parse(manifest); } catch(e) { pastes = []; }
      }
      return new Response(JSON.stringify(pastes), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 保存内容（HTML body）
    if (path === '/api/paste' && request.method === 'POST') {
      try {
        // 请求体预检
        const cl = Number(request.headers.get('content-length') || 0);
        if (cl > 500 * 1024) {
          return new Response(JSON.stringify({ error: '内容过大（超过 300KB）' }), {
            status: 413, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const body = await request.json();
        // name 净化：去控制字符、限 60 字符
        const name = String(body.name || '').replace(/[\x00-\x1f]/g, '').substring(0, 60) || '内容';
        let html = String(body.html || '');
        if (!html.trim()) {
          return new Response(JSON.stringify({ error: '内容为空' }), {
            status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        // 大小限制 300KB（UTF-8 中文 3 字节/字，约 10 万字）
        if (html.length > 300 * 1024) {
          return new Response(JSON.stringify({ error: '内容超过 300KB 限制' }), {
            status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        // 服务端兜底清洗：去 script 标签与事件属性
        html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<script[\s\S]*/gi, '');
        // 数量限制 20 个
        let manifest = await env.DATA_KV.get('pastes:manifest');
        let pastes = [];
        if (manifest) {
          try { pastes = JSON.parse(manifest); } catch(e) { pastes = []; }
        }
        if (pastes.length >= 20) {
          return new Response(JSON.stringify({ error: '内容数量已达上限（20个），请先删除旧内容' }), {
            status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const entry = { id, name, size: html.length, ts: Date.now() };
        pastes.push(entry);
        await Promise.all([
          env.DATA_KV.put('paste:' + id, html),
          env.DATA_KV.put('pastes:manifest', JSON.stringify(pastes))
        ]);
        return new Response(JSON.stringify({ ok: true, id, entry }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: '保存失败: ' + e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 获取单条内容（HTML 文本）
    if (path.startsWith('/api/paste/') && request.method === 'GET') {
      const id = path.slice('/api/paste/'.length);
      if (!id || id.includes('/')) {
        return new Response('Bad request', { status: 400 });
      }
      try {
        const html = await env.DATA_KV.get('paste:' + id);
        if (html === null) {
          return new Response('Not found', { status: 404 });
        }
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response('Error', { status: 500 });
      }
    }

    // 删除内容
    if (path === '/api/paste' && request.method === 'DELETE') {
      try {
        const body = await request.json();
        const { id } = body;
        if (!id) {
          return new Response(JSON.stringify({ error: '缺少 id' }), {
            status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        let manifest = await env.DATA_KV.get('pastes:manifest');
        let pastes = [];
        if (manifest) {
          try { pastes = JSON.parse(manifest); } catch(e) { pastes = []; }
        }
        pastes = pastes.filter(e => e.id !== id);
        await Promise.all([
          env.DATA_KV.delete('paste:' + id),
          env.DATA_KV.put('pastes:manifest', JSON.stringify(pastes))
        ]);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: '删除失败: ' + e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ========== Bridge Config (KV持久化，云部署用) ==========

    if (path === '/api/bridge/config' && request.method === 'GET') {
      const raw = await env.DATA_KV.get('bridge:account');
      const syncBuf = await env.DATA_KV.get('bridge:sync_buf');
      return new Response(JSON.stringify({
        account: raw ? JSON.parse(raw) : null,
        syncBuf: syncBuf || ''
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/bridge/config' && request.method === 'POST') {
      const body = await request.json();
      if (body.account) {
        await env.DATA_KV.put('bridge:account', JSON.stringify(body.account));
      }
      if (body.syncBuf !== undefined) {
        await env.DATA_KV.put('bridge:sync_buf', body.syncBuf);
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // ========== Bridge API (微信桥接 → Worker) ==========

    if (path === '/api/bridge/chat' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { userId, message, history } = body;
        if (!message) {
          return new Response(JSON.stringify({ error: '缺少 message 参数' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Resolve API key from KV config
        const apiKey = (await getKVCached(env, 'config:ai_api_key'))
          || (await getKVCached(env, 'config:deepseek_api_key'))
          || env.AI_API_KEY
          || env.DEEPSEEK_API_KEY;

        if (!apiKey) {
          return new Response(JSON.stringify({ reply: '（未配置 AI API Key，请在 megz 导出设置中配置 DeepSeek 或 Gemini API Key）' }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Build messages array with system prompt
        const messages = [{
          role: 'system',
          content:
            '你是「生活记事录」助手的微信机器人，通过微信为用户提供贷款销售相关的AI辅助。\n' +
            '你的能力包括：回答贷款业务问题、查询客户信息、提炼学习知识、查询白名单企业、搜索话术库和知识库。\n' +
            '你是专业的贷款销售助手，用中文回复。简洁直接，适合微信阅读。'
        }];

        // Include conversation history if provided
        if (history && Array.isArray(history)) {
          for (const h of history.slice(-20)) {
            messages.push({ role: h.role, content: h.content });
          }
        }

        // Add current message
        messages.push({ role: 'user', content: message });

        // Use tool-enabled chat for data-aware queries
        const needsTools = /客户|白名单|企业|公司|查|搜索|知识|话术|学习|统计|数据/.test(message);
        let reply;

        if (needsTools) {
          const supabase = createSupabaseClient(env);
          const toolMessages = [{
            role: 'system',
            content:
              '你是「生活记事录」助手的微信机器人。\n' +
              '可用工具：search_customers（查客户）、check_company_whitelist（查白名单）、' +
              'search_knowledge_and_speech（查知识库/话术/贷款案例）、get_intent_clients（查今日工作数据）、' +
              'add_learning_material（提炼学习材料）。\n' +
              '用中文回复，简洁适合微信。'
          }];
          if (history && Array.isArray(history)) {
            for (const h of history.slice(-20)) toolMessages.push({ role: h.role, content: h.content });
          }
          toolMessages.push({ role: 'user', content: message });

          const aiResp = await callAIChatWithTools(env, toolMessages, 0.7, apiKey, supabase);
          reply = aiResp?.choices?.[0]?.message?.content || '（AI 未返回有效回复）';
        } else {
          const aiResp = await callAIChat(env, messages, 0.7, apiKey);
          reply = aiResp?.choices?.[0]?.message?.content || '（AI 未返回有效回复）';
        }

        return new Response(JSON.stringify({ reply }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        console.error('Bridge chat error:', err.message);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    if (path === '/api/bridge/learning/save' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { conversationText, source_type } = body;
        if (!conversationText) {
          return new Response(JSON.stringify({ error: '缺少 conversationText 参数' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const apiKey = (await getKVCached(env, 'config:ai_api_key'))
          || (await getKVCached(env, 'config:deepseek_api_key'))
          || env.AI_API_KEY
          || env.DEEPSEEK_API_KEY;

        if (!apiKey) {
          const preview = conversationText.slice(0, 100).replace(/\n/g, ' ');
          const mockResult = {
            title: '微信对话提炼',
            summary: preview.length > 50 ? preview.slice(0, 50) + '...' : preview,
            content: '（模拟AI提炼）\n' + conversationText.slice(0, 500),
            tags: ['微信', '学习', '对话提炼'],
            source_type: source_type || '微信聊天',
          };
          return new Response(JSON.stringify({ success: true, data: mockResult, isMock: true }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const messages = [
          {
            role: 'system',
            content:
              '你是一个智能贷款销售学习助手。根据用户提供的微信聊天记录，进行深度提炼。\n\n' +
              '你必须只输出以下 JSON 格式（不要包裹 markdown 代码块）：\n' +
              '{"title":"提炼的知识标题（15字以内）","summary":"一句话摘要（30字以内）","content":"提炼的核心话术/知识要点（150字以内）","tags":["标签1","标签2"]}'
          },
          { role: 'user', content: `来源类型：${source_type || '微信聊天'}\n\n内容：\n${conversationText}` }
        ];

        const aiResp = await callAIChat(env, messages, 0.3, apiKey);
        let text = aiResp?.choices?.[0]?.message?.content || '';
        text = text.trim();
        if (text.startsWith('```')) {
          text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        }
        const parsed = JSON.parse(text);

        const result = {
          title: parsed.title || '自主学习提炼',
          summary: parsed.summary || '',
          content: parsed.content || '',
          tags: Array.isArray(parsed.tags) ? parsed.tags : ['学习'],
          source_type: source_type || '微信聊天',
        };

        try {
          const supabase = createSupabaseClient(env);
          await supabase.saveKnowledge(result);
        } catch (e) { /* non-critical */ }

        return new Response(JSON.stringify({ success: true, data: result }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        console.error('Bridge learning save error:', err.message);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ========== AI学习 API ==========

    if (path === '/api/learning/save' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { source_type, content, apiKey } = body;
        if (!source_type || !content) {
          return new Response(JSON.stringify({ error: '缺少 source_type 或 content 参数' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Get key from body, or KV config, or env
        let hasKey = apiKey || await env.DATA_KV.get('config:ai_api_key') || await env.DATA_KV.get('config:deepseek_api_key') || await env.DATA_KV.get('config:vision_api_key') || env.AI_API_KEY || env.DEEPSEEK_API_KEY;

        if (!hasKey) {
          const mockTitles = {
            '微信聊天': '微信客情维护与意向跟进',
            '电话录音': '电话触客异议处理技巧',
            '客户案例': '建易贷成功批贷案例分析',
            '企业资料': '企业准入白名单核心要点'
          };
          const mockTags = {
            '微信聊天': ['微信话术', '客情跟进'],
            '电话录音': ['电话开场', '异议处理'],
            '客户案例': ['批贷案例', '建易贷'],
            '企业资料': ['企业准入', '白名单']
          };
          const title = mockTitles[source_type] || '自主学习提炼';
          const tags = mockTags[source_type] || ['学习', '业务知识'];
          const summary = content.length > 30 ? content.slice(0, 27) + '...' : content;
          
          const mockResult = {
            title: title,
            summary: summary,
            content: '（模拟AI提炼）\n' + content,
            tags: tags,
            source_type: source_type
          };
          
          try {
            await supabase.saveKnowledge(mockResult);
          } catch(se) {
            console.error('[supabase] saveKnowledge error:', se.message);
          }

          return new Response(JSON.stringify({ success: true, data: mockResult, isMock: true }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const apiData = await callAIChat(env, [
          {
            role: 'system',
            content: '你是一个智能贷款销售学习助手。根据用户提供的销售原始材料（微信聊天记录、电话录音文本、客户案例、或企业资料），进行深度提炼，总结出可以直接用于锁屏学习、话术背诵、业务记忆的核心知识。\n\n请必须只输出以下 JSON 格式的字符串（不要包裹 markdown 代码块，如 ```json，只需输出 JSON 本身）：\n{\n  "title": "提炼的知识标题 (15字以内)",\n  "summary": "一句话摘要 (30字以内)",\n  "content": "提炼的核心话术/知识要点 (150字以内)",\n  "tags": ["标签1", "标签2"]\n}'
          },
          {
            role: 'user',
            content: `来源类型: ${source_type}\n\n内容:\n${content}`
          }
        ], 0.3, apiKey);

        let aiContent = apiData.choices[0].message.content.trim();
        
        if (aiContent.startsWith('```')) {
          aiContent = aiContent.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
        }

        const parsedResult = JSON.parse(aiContent);
        parsedResult.source_type = source_type;

        try {
          await supabase.saveKnowledge(parsedResult);
        } catch(se) {
          console.error('[supabase] saveKnowledge error:', se.message);
        }

        return new Response(JSON.stringify({ success: true, data: parsedResult }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ========== 白名单 API ==========

    // 上传白名单企业（批量 upsert）
    if (path === '/api/whitelist/upload' && request.method === 'POST') {
      try {
        const body = await request.json();
        const companies = body.companies;
        if (!Array.isArray(companies) || companies.length === 0) {
          return new Response(JSON.stringify({ error: '请提供 companies 数组' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        if (companies.length > 50000) {
          return new Response(JSON.stringify({ error: '单次最多上传 50000 家企业' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const result = await supabase.upsertCompanies(companies);
        return new Response(JSON.stringify({ success: true, count: result.count }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 获取所有白名单企业
    if (path === '/api/whitelist/companies' && request.method === 'GET') {
      try {
        const companies = await supabase.getAllCompanies();
        return new Response(JSON.stringify({ companies: companies }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }
    // 云端 AI 视觉 OCR 识别 (全图)
    if (path === '/api/ocr' && request.method === 'POST') {
      try {
        const body = await request.json();
        const base64 = body.image.replace(/^data:image\/\w+;base64,/, '');
        
        let imgArray;
        try {
          const { Buffer } = await import('node:buffer');
          imgArray = Buffer.from(base64, 'base64');
        } catch(e) {
          const binaryString = atob(base64);
          imgArray = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            imgArray[i] = binaryString.charCodeAt(i);
          }
        }

        const visionKey = await env.DATA_KV.get('config:vision_api_key') || '';
        let text = '';

        const fullVisionPrompt = "请识别并提取这张表格截图中的所有文字内容，保持行对齐。\n" +
          "特别注意：\n" +
          "1. 表格第一列通常为单字姓氏或姓名，可能紧邻左上角蓝色三角标里的“新”字（或“新”）。该“新”字属于标记符号，并非姓名的一部分，请在识别提取姓名/姓氏时，务必自动清洗掉前置的“新”字（例如：将“新 蔡”或“新蔡”清洗并只保留姓氏“蔡”）。\n" +
          "2. 必须精准识别并提取出原始中文字符（如温、朱、刘、严等），绝对不要将其转换为拼音或英文字母（例如：严禁将“温”提取为“Wen”），也不要进行翻译。\n" +
          "请以结构化的文本列表输出（每一行代表一个客户，包含姓名、手机号、公司、公积金/备注等信息）。\n" +
          "只输出提取到的文本内容，不要包含任何解释、分析或 markdown 代码块。";

        if (visionKey) {
          try {
            const apiBase = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
            const resp = await fetch(apiBase, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + visionKey
              },
              body: JSON.stringify({
                model: 'gemini-2.5-flash',
                messages: [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: fullVisionPrompt
                      },
                      {
                        type: 'image_url',
                        image_url: {
                          url: body.image
                        }
                      }
                    ]
                  }
                ],
                max_tokens: 1500,
                temperature: 0.1
              })
            });
            if (resp.ok) {
              const data = await resp.json();
              if (data.choices && data.choices[0] && data.choices[0].message) {
                text = (data.choices[0].message.content || '').trim();
              }
            } else {
              console.error('Gemini full vision API failed: ' + (await resp.text()));
            }
          } catch (geminiErr) {
            console.error('Gemini full vision API call error:', geminiErr);
          }
        }

        if (!text) {
          try {
            const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
              image: imgArray,
              prompt: fullVisionPrompt,
              max_tokens: 1000
            });
            text = (response.response || '').trim();
          } catch (llamaErr) {
            const errStr = String(llamaErr.message || llamaErr);
            if (errStr.includes('terms') || errStr.includes('license') || errStr.includes('agree')) {
              try {
                console.log('Workers AI terms agreement needed for full vision, trying to auto-agree...');
                await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'agree' });
                const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
                  image: imgArray,
                  prompt: fullVisionPrompt,
                  max_tokens: 1000
                });
                text = (response.response || '').trim();
              } catch (retryErr) {
                throw new Error('Workers AI Llama Full Vision retry failed: ' + retryErr.message);
              }
            } else {
              throw llamaErr;
            }
          }
        }

        return new Response(JSON.stringify({ text: text }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Workers AI 单细胞视觉模型识别 (Fallback)
    if (path === '/api/ocr/vision_cell' && request.method === 'POST') {
      try {
        const body = await request.json();
        const base64 = body.image.replace(/^data:image\/\w+;base64,/, '');
        
        let imgArray;
        try {
          const { Buffer } = await import('node:buffer');
          imgArray = Buffer.from(base64, 'base64');
        } catch(e) {
          const binaryString = atob(base64);
          imgArray = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            imgArray[i] = binaryString.charCodeAt(i);
          }
        }

        const visionKey = await env.DATA_KV.get('config:vision_api_key') || '';
        let text = '';

        const visionPrompt = "Please extract the original Chinese character (usually a single surname, e.g., 温, 刘, 朱) from this image. You MUST output ONLY the original Chinese character itself. DO NOT translate to pinyin, DO NOT output English letters, and DO NOT write any explanation. If no Chinese character is found, output nothing. \n请提取图片中的中文字符（通常是单个姓氏，例如：温、刘、朱）。你必须**只输出原中文字符本身**。**严禁输出任何英文字母、拼音或解释说明**。如果没有中文字符，请输出空。";

        if (visionKey) {
          try {
            const apiBase = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
            const resp = await fetch(apiBase, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + visionKey
              },
              body: JSON.stringify({
                model: 'gemini-2.5-flash',
                messages: [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: visionPrompt
                      },
                      {
                        type: 'image_url',
                        image_url: {
                          url: body.image
                        }
                      }
                    ]
                  }
                ],
                max_tokens: 10,
                temperature: 0.1
              })
            });
            if (resp.ok) {
              const data = await resp.json();
              if (data.choices && data.choices[0] && data.choices[0].message) {
                text = (data.choices[0].message.content || '').trim();
              }
            } else {
              console.error('Gemini vision API failed: ' + (await resp.text()));
            }
          } catch (geminiErr) {
            console.error('Gemini API call error:', geminiErr);
          }
        }

        if (!text) {
          try {
            const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
              image: [...imgArray],
              prompt: visionPrompt,
              max_tokens: 10
            });
            text = (response.response || '').trim();
          } catch (llamaErr) {
            const errStr = String(llamaErr.message || llamaErr);
            if (errStr.includes('terms') || errStr.includes('license') || errStr.includes('agree')) {
              try {
                console.log('Workers AI terms agreement needed, trying to auto-agree...');
                await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'agree' });
                const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
                  image: [...imgArray],
                  prompt: visionPrompt,
                  max_tokens: 10
                });
                text = (response.response || '').trim();
              } catch (retryErr) {
                throw new Error('Workers AI Llama Vision retry failed: ' + retryErr.message);
              }
            } else {
              throw llamaErr;
            }
          }
        }

        // remove any AI conversational filler like "The text is:" or quotes
        text = text.replace(/^["']|["']$/g, '').replace(/The text is:?\s*/i, '').trim();

        return new Response(JSON.stringify({ text: text }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // OCR 文本提取（粘贴文本直接解析）
    if (path === '/api/ocr/text' && request.method === 'POST') {
      try {
        const body = await request.json();
        const rawText = body.rawText || '';
        if (!rawText.trim()) {
          return new Response(JSON.stringify({ contacts: [] }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Server-side phone number extraction
        var phoneRe = /1[3-9]\d{9}/g;
        var seenPhones = {};
        var extractedContacts = [];
        var lines = rawText.split(/\r?\n/);

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line) continue;
          var phones = line.match(phoneRe);
          if (!phones) continue;
          phones.forEach(function(phone) {
            if (seenPhones[phone]) return;
            seenPhones[phone] = true;

            var name = '', company = '', note = '';
            var cols = line.split(/\t/);

            if (cols.length >= 3) {
              // Tab-separated format
              var phoneCol = -1;
              for (var ci = 0; ci < cols.length; ci++) {
                if (cols[ci].includes(phone)) { phoneCol = ci; break; }
              }
              if (phoneCol >= 0) {
                if (phoneCol > 0) {
                  var rawName = cols[phoneCol - 1].trim();
                  var cleanedName = rawName.replace(/^[新旧]\s*/, '').trim();
                  name = cleanedName.length === 0 ? rawName : cleanedName;
                }
                for (var ci2 = phoneCol + 1; ci2 < cols.length; ci2++) {
                  var val = cols[ci2].trim();
                  if (val && !/^[\d.]+$/.test(val) && val !== '新增跟进' && val !== '已拨') {
                    company = val; break;
                  }
                }
              }
            } else {
              // Space-separated or multi-line format
              var before = line.substring(0, line.indexOf(phone));
              var nm = before.match(/([一-龥]{1,4})\s*$/);
              if (nm) {
                var rawNm = nm[1];
                var cleanedNm = rawNm.replace(/^[新旧]\s*/, '');
                name = cleanedNm.length === 0 ? rawNm : cleanedNm;
              } else {
                // Look at previous lines for name (multi-line format)
                for (var j = i - 1; j >= 0 && j >= i - 2; j--) {
                  var prev = lines[j].trim();
                  if (prev && /^[一-龥]{1,4}$/.test(prev)) { name = prev; break; }
                }
              }

              var after = line.substring(line.indexOf(phone) + phone.length).trim();

              if (after && /^\d+/.test(after)) {
                // Phone line has trailing number → note/amount
                note = after;
                // Company on next line
                for (var k = i + 1; k < lines.length && k <= i + 2; k++) {
                  var nl = lines[k].trim();
                  if (nl && !/^\d+$/.test(nl) && nl.length > 1) { company = nl; break; }
                }
              } else if (after) {
                // Phone line has trailing text → company (possibly + status)
                company = after.replace(/[\d.]+[\d\s]*$/g, '').replace(/\s*(新增跟进|已拨|正常号|空号|停机|无法接通).*$/, '').trim();
              } else {
                // Nothing after phone — scan next lines
                for (var k2 = i + 1; k2 < lines.length && k2 <= i + 3; k2++) {
                  var nl2 = lines[k2].trim();
                  if (!nl2) continue;
                  if (/^\d+$/.test(nl2)) {
                    // Number → note/amount
                    if (!note) note = nl2;
                  } else if (nl2.length > 1 && !/^\d{11}$/.test(nl2)) {
                    // Text → company
                    company = nl2; break;
                  }
                }
              }
            }

            extractedContacts.push({ name: name, phone: phone, company: company, note: note });
          });
        }

        return new Response(JSON.stringify({ contacts: extractedContacts }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }


    // POST /api/ocr/test — Test Gemini/AI API connectivity
    if (path === '/api/ocr/test' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { saveOnly, visionApiKey, visionApiBase } = body;
        
        if (visionApiKey !== undefined) {
          await env.DATA_KV.put('config:vision_api_key', visionApiKey || '');
        }
        if (visionApiBase !== undefined) {
          await env.DATA_KV.put('config:vision_api_base', visionApiBase || '');
        }
        
        if (saveOnly) {
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        
        // Connectivity test
        const apiKey = visionApiKey || await env.DATA_KV.get('config:vision_api_key') || '';
        if (!apiKey) {
          return new Response(JSON.stringify({ success: false, error: 'API Key 不能为空' }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        
        let apiBase = visionApiBase || await env.DATA_KV.get('config:vision_api_base') || 'https://generativelanguage.googleapis.com/v1beta/openai/';
        if (!apiBase.endsWith('/')) apiBase += '/';
        const url = apiBase + 'chat/completions';
        
        const testResp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
          },
          body: JSON.stringify({
            model: 'gemini-2.5-flash',
            messages: [{ role: 'user', content: 'Say OK' }],
            max_tokens: 5
          })
        });
        
        if (!testResp.ok) {
          const errText = await testResp.text();
          return new Response(JSON.stringify({ success: false, error: `API 返回错误 (${testResp.status}): ${errText}` }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // OCR 文本修正与数据融合：用文本 AI 修正本地 WASM OCR 的识别错误，或进行双通道（本地OCR与云端视觉）数据融合纠错
    if (path === '/api/ocr/correct' && request.method === 'POST') {
      try {
        const body = await request.json();
        const localContacts = body.localContacts || null;
        const visionText = body.visionText || '';
        const rawText = body.rawText || '';
        const fileName = body.fileName || '';

        // Get the regular AI config
        let provider = await env.DATA_KV.get('config:ai_provider') || 'gemini';
        const visionKey = await env.DATA_KV.get('config:vision_api_key') || '';
        const aiKey = await env.DATA_KV.get('config:ai_api_key') || await env.DATA_KV.get('config:deepseek_api_key') || env.AI_API_KEY || env.DEEPSEEK_API_KEY || '';
        
        let apiKey = aiKey;
        if (provider === 'gemini' || (visionKey && !aiKey)) {
          provider = 'gemini';
          apiKey = visionKey || aiKey;
        }

        let apiBase = await env.DATA_KV.get('config:ai_api_base') || env.AI_API_BASE;
        let model = await env.DATA_KV.get('config:ai_model') || env.AI_API_MODEL;

        if (provider === 'gemini') {
          if (!apiBase) apiBase = 'https://generativelanguage.googleapis.com/v1beta/openai/';
          if (!model) model = 'gemini-2.5-flash';
        } else {
          if (!apiBase) apiBase = 'https://api.deepseek.com/v1/';
          if (!model) model = 'deepseek-chat';
        }

        if (!localContacts) {
          // ==================== Case 1: 仅修正/解析文本 (原逻辑) ====================
          if (!rawText.trim()) {
            return new Response(JSON.stringify({ contacts: [] }), {
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }

          if (!apiKey) {
            var fallbackContacts = extractContactsFromRawText(rawText);
            return new Response(JSON.stringify({ contacts: fallbackContacts, rawText: rawText, engine: 'regex_fallback' }), {
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }

          let url = apiBase;
          if (!url.endsWith('/')) url += '/';
          url += 'chat/completions';

          const systemPrompt = '你是一个 OCR 文本修正专家。下面的文本是从图片中通过 OCR 引擎识别出来的，典型错误包括：\n' +
            '1. 数字识别错误：0和O/o混淆、1和l/I/|混淆、8和B混淆、3和8混淆、5和6混淆、7和1混淆\n' +
            '2. 汉字识别错误：形近字混淆（如"张"误识别为"长"或"弓长"、"葛"识别错、"莫"识别错等）\n' +
            '3. 手机号错误：数字混入字母（如138识别为I38）\n' +
            '4. 换行和空格导致文本断裂或错位\n\n' +
            '【文本排版特征与重要前置说明】：\n' +
            '源图片是一个从左往右横向排版的表格。**每一行都代表且仅代表一个独立客户的所有关联信息，每一列都是特定的类别分类。**\n' +
            '由于缺少框线或识别误差，数据可能会发生错位、换行或断裂。你需要根据“横向为一行”的视觉逻辑，以11位手机号为核心锚点，寻找并还原与其属于同一行的所有客户信息。\n' +
            '每一行的典型字段排列顺序通常为：【姓/姓名】 【手机号】 【公积金/金额】 【公司/单位名称】 【备注】\n' +
            '例如 OCR 识别出的文本行为：“青 13510625191 27501 苏州热工研究院有限公司深圳分公司”，请对应地提取出各字段。\n\n' +
            '【你的任务】：\n' +
            '1. 逐行修正 OCR 文本中的所有识别错误，恢复拼写及排版。\n' +
            '2. 将手机号恢复为 11 位纯数字。\n' +
            '3. 修正明显被拆分或错别的汉字。\n' +
            '4. 按照规则提取所有联系人信息。\n\n' +
            '【提取规则】：\n' +
            '- name: 中文姓名（1-4个汉字）。注意：第一列通常为单字姓氏（如常见的单字姓氏），即使只有一个汉字，也是联系人的姓名/姓氏，请务必完整提取并填充到 name 字段，绝对不要忽略、丢弃或擅自补全为其他字。\n' +
            '- phone: 11位纯数字手机号（1开头）\n' +
            '- company: 公司/单位名称（包括：公司、企业、工厂、学校、幼儿园、小学、中学、大学、学院、研究院、研究所、实验室、医院、银行、政府机构、事业单位等所有组织机构）\n' +
            '- fund: 对应的公积金数字或金额数字（通常在手机号之后、公司名称之前，例如 27501、9660、24100 等）\n' +
            '- note: 必须映射到此处的真实备注信息（如果识别出其他不能归类为公司或资金的文本，请放入此处）。\n\n' +
            '输出纯JSON（禁止markdown包裹）：\n' +
            '{\n  "correctedText": "修正后的完整原文...",\n  "corrections": [{"original": "识别错的", "corrected": "正确的", "reason": "原因"}],\n' +
            '  "contacts": [{"name": "", "phone": "", "company": "", "fund": "", "note": ""}]\n}';

          let aiResp;
          let maxRetries = 3;
          let retryDelay = 2000;
          
          for (let i = 0; i < maxRetries; i++) {
            aiResp = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey
              },
              body: JSON.stringify({
                model: model,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: '请修正以下 OCR 文本并提取联系人：\n\n' + rawText.substring(0, 8000) }
                ],
                temperature: 0,
                max_tokens: 4096
              })
            });
            
            if (aiResp.ok) {
              break;
            }
            
            if (aiResp.status === 429 || aiResp.status >= 500) {
              if (i < maxRetries - 1) {
                console.log(`[OCR Correct] AI API rate limited or server error (${aiResp.status}), retrying in ${retryDelay}ms...`);
                await new Promise(r => setTimeout(r, retryDelay));
                retryDelay *= 2; // Exponential backoff
                continue;
              }
            } else {
              // Not a retryable error (e.g. 400, 401)
              break;
            }
          }

          if (!aiResp.ok) {
            const errText = await aiResp.text();
            console.error('[OCR Correct] AI API error:', aiResp.status, errText.substring(0, 200));
            var fbContacts = extractContactsFromRawText(rawText);
            return new Response(JSON.stringify({ contacts: fbContacts, rawText: rawText, engine: 'regex_fallback' }), {
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }

          const aiData = await aiResp.json();
          let content = aiData.choices[0].message.content.trim();
          if (content.startsWith('```')) {
            content = content.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
          }

          let parsed;
          try {
            parsed = JSON.parse(content);
          } catch (e) {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[0]); } catch(e2) {} }
          }

          if (!parsed || !parsed.contacts || parsed.contacts.length === 0) {
            var fbContacts2 = extractContactsFromRawText(rawText);
            return new Response(JSON.stringify({ contacts: fbContacts2, rawText: rawText, engine: 'regex_fallback' }), {
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }

          var contacts = parsed.contacts.map(function(c) {
            if (!c) return null;
            var phone = (c.phone || '').replace(/[oOiIlLbB\s\-]/g, function(m) {
              return {o:'0',O:'0',i:'1',I:'1',l:'1',L:'1',b:'6',B:'8'}[m] || '';
            }).replace(/\D/g, '');
            
            // Clean name (strip leading "新", "旧", "听", "一" etc. badge characters)
            var name = (c.name || '').trim();
            name = name.replace(/^[新旧听一]+[\s\-\|]*/, '').replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '').trim();
            
            return {
              name: name,
              phone: phone.length === 11 && phone[0] === '1' ? phone : '',
              company: (c.company || '').trim(),
              fund: (c.fund || '').trim(),
              note: (c.note || '').trim()
            };
          }).filter(function(c) { return c && c.phone; });

          console.log('[OCR Correct] AI corrected ' + contacts.length + ' contacts from raw text (' + rawText.length + ' chars)');

          try {
            const sb = createSupabaseClient(env);
            await sb.saveCorrection({
              rawText: rawText.substring(0, 1000),
              originalContacts: extractContactsFromRawText(rawText),
              correctedContacts: contacts,
              sourceFile: fileName || 'ocr_correct',
              ocrPipeline: 'text_ai_correct',
              ocrMode: 'bulk',
              editCount: parsed.corrections ? parsed.corrections.length : 1,
              metadata: { correctedText: parsed.correctedText || '', corrections: parsed.corrections || [] }
            });
          } catch (saveErr) {
            console.warn('[OCR Correct] Failed to save training data:', saveErr.message);
          }

          return new Response(JSON.stringify({
            contacts: contacts,
            rawText: rawText,
            correctedText: parsed.correctedText || '',
            corrections: parsed.corrections || [],
            engine: 'text_ai_correct'
          }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // ==================== Case 2: 本地 OCR 与云端 Vision AI 结果融合 (混合管线) ====================
        if (!apiKey) {
          return new Response(JSON.stringify({ contacts: localContacts, engine: 'local_only_no_key' }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        let url = apiBase;
        if (!url.endsWith('/')) url += '/';
        url += 'chat/completions';

        const mergeSystemPrompt = '你是一个 OCR 数据融合专家。下面有两份来自同一张客户登记表格截图的识别数据：\n' +
          '1. 【本地 OCR 提取数据】：这是通过本地 Wasm Tesseract 切片提取的，它的特征是【手机号、公司名称和公积金/金额】识别极其精准，但由于表格左侧图标干扰，【姓名/姓氏】常被误识别（如将“温”识别为“严”）、遗漏或变为乱码字符。\n' +
          '2. 【云端视觉 AI 文本】：这是多模态大模型对原图进行完整 OCR 识别得到的原始文本，它的特征是【姓名/姓氏】识别极其精准（特别是单字姓氏），但手机号偶有细微数字错乱。\n\n' +
          '【你的任务】：\n' +
          '请利用这两份数据进行智能对齐与纠错融合：\n' +
          '- 以手机号为核心轴，将【本地 OCR 提取数据】的每一行与【云端视觉 AI 文本】对应的行进行匹配对齐。\n' +
          '- 姓名（name）字段：必须优先采用【云端视觉 AI 文本】中识别出的正确姓氏或姓名，纠正本地数据中因图标干扰导致的错别字（如将“严”纠正为“温/朱/刘”等原始汉字）、遗漏或多余字符。第一列通常为单字姓氏，请务必完整保留，不要过滤掉单字姓氏。\n' +
          '- 手机号（phone）字段：必须优先采用【本地 OCR 提取数据】中精准无误的 11 位数字手机号。\n' +
          '- 公司名称（company）、公积金（fund）和备注（note）字段：结合两份数据进行合理补充与合并。\n\n' +
          '输出纯 JSON（不要包含 markdown 代码块包裹，只输出 JSON 本身，格式必须符合）：\n' +
          '{\n  "contacts": [{"name": "正确姓名", "phone": "11位纯数字手机", "company": "正确公司", "fund": "公积金金额", "note": "备注"}]\n}';

        const userMessage = '请将以下本地 OCR 提取的列表与云端 AI 视觉提取的原始文本进行合并纠错：\n\n' +
          '【本地 OCR 提取数据】：\n' + JSON.stringify(localContacts, null, 2) + '\n\n' +
          '【云端视觉 AI 文本】：\n' + visionText;

        const aiResp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: 'system', content: mergeSystemPrompt },
              { role: 'user', content: userMessage }
            ],
            temperature: 0.1,
            max_tokens: 4096
          })
        });

        if (!aiResp.ok) {
          const errText = await aiResp.text();
          console.error('[OCR Merge] AI API error:', aiResp.status, errText.substring(0, 200));
          return new Response(JSON.stringify({ contacts: localContacts, engine: 'local_only_api_error' }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const aiData = await aiResp.json();
        let content = aiData.choices[0].message.content.trim();
        if (content.startsWith('```')) {
          content = content.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
        }

        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch(e2) {}
          }
        }

        if (parsed && parsed.contacts) {
          const cleanedContacts = parsed.contacts.map(function(c) {
            if (!c) return null;
            var name = (c.name || '').trim();
            name = name.replace(/^[新旧听一]+[\s\-\|]*/, '').replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '').trim();
            return {
              name: name,
              phone: (c.phone || '').trim(),
              company: (c.company || '').trim(),
              fund: (c.fund || '').trim(),
              note: (c.note || '').trim()
            };
          }).filter(Boolean);

          return new Response(JSON.stringify({ contacts: cleanedContacts, engine: 'hybrid_merge' }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        return new Response(JSON.stringify({ contacts: localContacts, engine: 'local_only_parse_failed' }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        console.error('[OCR Correct] error:', e.message);
        return new Response(JSON.stringify({ error: 'OCR 文本修正失败: ' + e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // POST /api/ocr/categorize — Clean, correct, and re-classify contacts lists using text AI
    if (path === '/api/ocr/categorize' && request.method === 'POST') {
      let contactsList = [];
      try {
        const body = await request.json();
        contactsList = body.contacts || [];
        const fileName = body.fileName || '';
        
        if (contactsList.length === 0) {
          return new Response(JSON.stringify({ contacts: [] }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        let provider = await env.DATA_KV.get('config:ai_provider') || 'gemini';
        const visionKey = await env.DATA_KV.get('config:vision_api_key') || '';
        const aiKey = await env.DATA_KV.get('config:ai_api_key') || await env.DATA_KV.get('config:deepseek_api_key') || env.AI_API_KEY || env.DEEPSEEK_API_KEY || '';
        
        let apiKey = aiKey;
        if (provider === 'gemini' || (visionKey && !aiKey)) {
          provider = 'gemini';
          apiKey = visionKey || aiKey;
        }

        let apiBase = await env.DATA_KV.get('config:ai_api_base') || env.AI_API_BASE;
        let model = await env.DATA_KV.get('config:ai_model') || env.AI_API_MODEL;

        if (provider === 'gemini') {
          if (!apiBase) apiBase = 'https://generativelanguage.googleapis.com/v1beta/openai/';
          if (!model) model = 'gemini-2.5-flash';
        } else {
          if (!apiBase) apiBase = 'https://api.deepseek.com/v1/';
          if (!model) model = 'deepseek-chat';
        }

        if (!apiKey) {
          return new Response(JSON.stringify({ contacts: contactsList, engine: 'bypass' }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        let url = apiBase;
        if (!url.endsWith('/')) url += '/';
        url += 'chat/completions';

        const systemPrompt = '你是一个通讯录数据清洗与智能分类专家。输入是一个包含从图片表格中通过本地 OCR 识别初步对齐的联系人 JSON 数组。\n' +
          '【重要前置说明】：原始图片严格遵循“从左往右横向为一行（一个客户的所有信息），一列为一个特定类别”的结构。由于表格无框线、列间距小或识别误差，同一行的数据可能会发生错位，你需要根据“一行代表一个客户”的逻辑，对数据进行横向重新拼装与修正。\n\n' +
          '【具体清洗与归类规则】：\n' +
          '1. **姓名 (name)**：通常位于第一列，为1-4个汉字（允许单字姓氏，绝对不能漏掉）。如果“公司”等信息被误放入姓名列，请将其移出。姓名或公司若存在形近字识别错误，请结合语境修正。\n' +
          '2. **电话 (phone)**：这是最关键的锚点信息，绝对正确且不可更改！你需要以电话号码为准基线，寻找与其属于同一行的“姓名”、“公司”和“备注”信息。\n' +
          '3. **公司/单位 (company)**：如果原数据中公司名被错放在了姓名或备注列，请根据行对应关系，将其移动到此处；纠正错别字（如“腾城”->“鹏城”）。\n' +
          '4. **备注 (note)**：必须映射到数据库的备注栏。真实的附加信息（如职称、日期、职位、跟进情况等）。如果备注里包含公司名，请将公司名抽离到 company 字段，剩下的留作 note。不要随意舍弃有用的备注信息。\n\n' +
          '【输出格式】：\n' +
          '请严格遵循下方纯 JSON 格式输出（不要输出 Markdown 格式的 ```json），确保每个对象都包含 name, phone, company, note 四个字段：\n' +
          '{\n  "contacts": [\n    { "name": "正确的姓名", "phone": "13XXXXXXXXX", "company": "正确归类后的公司", "note": "提取的备注信息" }\n  ]\n}';

        const aiResp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: '请对以下初步提取的联系人列表进行清洗和重新分类归类：\n\n' + JSON.stringify(contactsList, null, 2) }
            ],
            temperature: 0,
            max_tokens: 4096
          })
        });

        if (!aiResp.ok) {
          const errText = await aiResp.text();
          console.error('[OCR Categorize] AI API error:', aiResp.status, errText.substring(0, 200));
          return new Response(JSON.stringify({ contacts: contactsList, engine: 'bypass_api_error' }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const aiData = await aiResp.json();
        let content = aiData.choices[0].message.content.trim();
        if (content.startsWith('```')) {
          content = content.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
        }

        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[0]); } catch(e2) {} }
        }

        if (!parsed || !parsed.contacts || parsed.contacts.length === 0) {
          return new Response(JSON.stringify({ contacts: contactsList, engine: 'bypass_parse_error' }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        console.log('[OCR Categorize] AI processed ' + parsed.contacts.length + ' contacts');

        return new Response(JSON.stringify({
          contacts: parsed.contacts,
          engine: 'text_ai_categorize'
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });

      } catch (e) {
        console.error('[OCR Categorize] error:', e.message);
        return new Response(JSON.stringify({ contacts: contactsList, error: e.message, engine: 'bypass_exception' }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Helper: phone + contact extraction from raw text (regex fallback)
    function extractContactsFromRawText(rawText) {
      var phoneRe = /1[3-9]\d{9}/g;
      var seenPhones = {};
      var contacts = [];
      var lines = rawText.split(/\r?\n/);
      lines.forEach(function(line) {
        line = line.trim();
        if (!line) return;
        var phones = line.match(phoneRe);
        if (!phones) return;
        phones.forEach(function(phone) {
          if (seenPhones[phone]) return;
          seenPhones[phone] = true;
          var name = '', company = '';
          var before = line.substring(0, line.indexOf(phone)).trim();
          var nm = before.match(/(?:^|\s)([一-龥]{2,4})(?=\s|$)/);
          if (!nm) nm = before.match(/^([一-龥]{2,4})/);
          if (!nm) nm = before.match(/([一-龥]{1,4})\s*$/);
          if (nm) name = nm[1].replace(/^[新旧听一]+[\s\-\|]*/, '');
          var after = line.substring(line.indexOf(phone) + phone.length).trim();
          company = after.replace(/[\d.]+[\d\s]*$/g, '').replace(/\s*(新增跟进|已拨|正常号|空号|停机|无法接通|挂断|意向|备注).*$/, '').trim();
          contacts.push({ name: name, phone: phone, company: company, fund: '', note: '' });
        });
      });
      return contacts;
    }


    // === OCR Correction Training Data APIs ===

    // POST /api/ocr/correction — save a correction pair
    if (path === '/api/ocr/correction' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { rawText, originalContacts, correctedContacts, sourceFile, ocrPipeline, ocrMode, metadata } = body;
        if (!rawText && (!originalContacts || originalContacts.length === 0)) {
          return new Response(JSON.stringify({ error: '缺少 rawText 或 originalContacts' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Compute edit_count by comparing original vs corrected
        var editCount = 0;
        if (originalContacts && correctedContacts) {
          for (var i = 0; i < Math.max(originalContacts.length, correctedContacts.length); i++) {
            var orig = originalContacts[i] || {};
            var corr = correctedContacts[i] || {};
            if (orig.name !== corr.name) editCount++;
            if (orig.phone !== corr.phone) editCount++;
            if (orig.company !== corr.company) editCount++;
            if (orig.note !== corr.note) editCount++;
          }
        }

        const sb = createSupabaseClient(env);
        const saved = await sb.saveCorrection({
          rawText: rawText || '',
          originalContacts: originalContacts || [],
          correctedContacts: correctedContacts || [],
          sourceFile: sourceFile || '',
          ocrPipeline: ocrPipeline || 'ai_vision',
          ocrMode: ocrMode || 'bulk',
          editCount: editCount,
          metadata: metadata || {}
        });

        // Update KV caches
        try {
          var countStr = await env.DATA_KV.get('correction:count');
          var count = parseInt(countStr || '0', 10) + 1;
          await env.DATA_KV.put('correction:count', String(count), { expirationTtl: 3600 });
          await env.DATA_KV.put('correction:last_sync', new Date().toISOString());

          // Update few_shot_examples ring buffer if user made edits
          if (editCount > 0 && originalContacts && correctedContacts) {
            var examples = [];
            try {
              var cached = await env.DATA_KV.get('config:few_shot_examples');
              if (cached) examples = JSON.parse(cached);
            } catch(e) {}
            examples.unshift({
              rawText: (rawText || '').substring(0, 500),
              originalContacts: originalContacts.map(function(c) {
                return { name: c.name || '', phone: c.phone || '', company: c.company || '', note: c.note || '' };
              }),
              correctedContacts: correctedContacts.map(function(c) {
                return { name: c.name || '', phone: c.phone || '', company: c.company || '', note: c.note || '' };
              })
            });
            if (examples.length > 20) examples.length = 20;
            await env.DATA_KV.put('config:few_shot_examples', JSON.stringify(examples), { expirationTtl: 86400 });
          }
        } catch (kvErr) {
          console.error('[OCR correction] KV update failed:', kvErr.message);
        }

        return new Response(JSON.stringify({ success: true, id: saved ? saved.id : null }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        console.error('[OCR correction] Save failed:', e.message);
        return new Response(JSON.stringify({ error: '保存修正记录失败: ' + e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // GET /api/ocr/corrections — list corrections
    if (path === '/api/ocr/corrections' && request.method === 'GET') {
      try {
        const url = new URL(request.url);
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') || '20', 10), 200);
        const minEdits = parseInt(url.searchParams.get('minEdits') || '0', 10);
        const sort = url.searchParams.get('sort') || 'newest';

        const sb = createSupabaseClient(env);
        const result = await sb.getCorrections(page, pageSize, minEdits, sort);

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        console.error('[OCR corrections] List failed:', e.message);
        return new Response(JSON.stringify({ error: '获取修正记录失败: ' + e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // GET /api/ocr/corrections/export — export as JSONL for fine-tuning
    if (path === '/api/ocr/corrections/export' && request.method === 'GET') {
      try {
        const url = new URL(request.url);
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 1000);

        const sb = createSupabaseClient(env);
        const rows = await sb.getCorrectionsForExport(limit);

        var jsonlLines = [];
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          jsonlLines.push(JSON.stringify({
            input: {
              rawText: row.raw_text || '',
              contacts: row.original_json || []
            },
            output: {
              contacts: row.corrected_json || []
            }
          }));
        }

        return new Response(jsonlLines.join('\n'), {
          headers: {
            'Content-Type': 'application/x-ndjson',
            'Content-Disposition': 'attachment; filename="ocr_training_data.jsonl"',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        console.error('[OCR correction export] Failed:', e.message);
        return new Response(JSON.stringify({ error: '导出失败: ' + e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // GET /api/ocr/corrections/stats — quick stats
    if (path === '/api/ocr/corrections/stats' && request.method === 'GET') {
      try {
        var count = 0;
        var lastSync = '';
        try {
          var cachedCount = await env.DATA_KV.get('correction:count');
          if (cachedCount) count = parseInt(cachedCount, 10) || 0;
          lastSync = await env.DATA_KV.get('correction:last_sync') || '';
        } catch (kvErr) {}

        // Fallback: query Supabase directly if KV is empty
        if (count === 0) {
          const sb = createSupabaseClient(env);
          count = await sb.getCorrectionsCount();
        }

        return new Response(JSON.stringify({ count: count, lastSync: lastSync }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        console.error('[OCR stats] Failed:', e.message);
        return new Response(JSON.stringify({ count: 0, lastSync: '' }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 检查客户单位是否在白名单
    if (path === '/api/whitelist/check' && request.method === 'POST') {
      try {
        const body = await request.json();
        const companies = body.companies;
        if (!Array.isArray(companies)) {
          return new Response(JSON.stringify({ error: '请提供 companies 数组' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const results = await supabase.checkCompanies(companies);
        return new Response(JSON.stringify({ results: results }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }


    // POST /api/destruct — 爆破密码：导出全部KV数据 → 邮件发送 → 清空
    if (path === '/api/destruct' && request.method === 'POST') {
      try {
        var body = await request.json();
        var inputPin = (body.pin || '').trim();
        var destructPin = env.DESTRUCT_PIN || '';
        if (!destructPin || !inputPin || inputPin.length < 9 || inputPin.length > 12 || inputPin !== destructPin) {
          return new Response(JSON.stringify({ error: 'PIN 错误' }), {
            status: 403, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
          });
        }

        var destructEmail = env.DESTRUCT_EMAIL || '';
        var resendKey = env.RESEND_API_KEY || await env.DATA_KV.get('config:resend_api_key') || '';

        // List and fetch all KV data
        var allData = {};
        var keyCount = 0;
        var cursor = null;
        do {
          var listResult = await env.DATA_KV.list({ cursor: cursor });
          for (var ki = 0; ki < listResult.keys.length; ki++) {
            var k = listResult.keys[ki];
            var raw = await env.DATA_KV.get(k.name);
            allData[k.name] = raw;
            keyCount++;
          }
          cursor = listResult.cursor || null;
        } while (cursor);

        var today = new Date();
        var dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0') + '_' + String(today.getHours()).padStart(2, '0') + String(today.getMinutes()).padStart(2, '0');

        // Generate JSON export
        var jsonStr = JSON.stringify(allData, null, 2);
        var base64 = Buffer.from(jsonStr, 'utf-8').toString('base64');

        // Send email if configured
        var emailResult = '未发送';
        if (destructEmail && resendKey) {
          var fromEmail = await env.DATA_KV.get('config:backup_from_email') || 'backup@resend.dev';
          try {
            var resendResp = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
              body: JSON.stringify({
                from: 'Megz Destruct <' + fromEmail + '>',
                to: [destructEmail],
                subject: 'Megz 数据销毁备份 - ' + dateStr,
                text: '爆破密码已触发。附件为全部 KV 数据备份（共 ' + keyCount + ' 个键），数据已从 KV 清除。',
                attachments: [{ filename: 'megz_destruct_' + dateStr + '.json', content: base64, content_type: 'application/json' }]
              })
            });
            emailResult = resendResp.ok ? '已发送' : '发送失败';
          } catch(e) { emailResult = '发送异常'; }
        }

        // Delete all KV keys in batches
        var deleted = 0;
        var delCursor = null;
        do {
          var delList = await env.DATA_KV.list({ cursor: delCursor });
          var keysToDelete = delList.keys.map(function(k) { return k.name; });
          if (keysToDelete.length > 0) {
            // Delete in chunks of 128 (KV batch limit)
            for (var dc = 0; dc < keysToDelete.length; dc += 128) {
              var chunk = keysToDelete.slice(dc, dc + 128);
              var delPromises = chunk.map(function(dk) { return env.DATA_KV.delete(dk); });
              await Promise.all(delPromises);
              deleted += chunk.length;
            }
          }
          delCursor = delList.cursor || null;
        } while (delCursor);

        return new Response(JSON.stringify({
          success: true,
          exported: keyCount,
          deleted: deleted,
          email: emailResult,
          time: dateStr
        }), {
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // POST /api/restore — 恢复数据：验证爆破密码后写入所有KV键值
    if (path === '/api/restore' && request.method === 'POST') {
      try {
        var body = await request.json();
        var inputPin = (body.pin || '').trim();
        var restoreData = body.data;
        var destructPin = env.DESTRUCT_PIN || '';
        if (!destructPin || !inputPin || inputPin.length < 9 || inputPin.length > 12 || inputPin !== destructPin) {
          return new Response(JSON.stringify({ error: 'PIN 错误' }), {
            status: 403, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
          });
        }
        if (!restoreData || typeof restoreData !== 'object') {
          return new Response(JSON.stringify({ error: '无效的备份数据' }), {
            status: 400, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
          });
        }
        var keys = Object.keys(restoreData);
        var written = 0;
        for (var rci = 0; rci < keys.length; rci += 128) {
          var chunk = keys.slice(rci, rci + 128);
          var writes = chunk.map(function(rk) {
            return env.DATA_KV.put(rk, restoreData[rk]);
          });
          await Promise.all(writes);
          written += chunk.length;
        }
        return new Response(JSON.stringify({ success: true, restored: written }), {
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 返回 HTML 页面
    return new Response(HTML, {
      headers: { 'Content-Type': 'text/html; charset=UTF-8' }
    });
  },

  // Cron 定时任务：AI 公积金自动修正（每天全量扫描）
  async scheduled(event, env, ctx) {
    // AI 公积金自动修正（每天全量扫描）
    try {
      console.log('[Cron] 开始 AI 公积金自动修正...');
      const result = await runAICorrectFund(env);
      console.log('[Cron] AI 修正完成:', JSON.stringify({
        total: result.total_scanned,
        suspicious: result.suspicious_found,
        corrected: result.ai_corrected,
        errors: (result.errors || []).length
      }));
    } catch (e) {
      console.error('[Cron] AI 修正异常:', e.message);
    }
  }
};
