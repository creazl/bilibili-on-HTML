const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const crypto = require('crypto');
const LRUCache = require('lru-cache');
const os = require("os");
const process = require("process");
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3001;

// JWT 密钥 (生产环境应使用环境变量)
const JWT_SECRET = 'your_strong_jwt_secret_key'; // 生产环境应使用环境变量
// 临时存储方案 (实际应使用数据库)
const users = [];
const sessions = {};

// 启用 CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// 官方 API 代理
const officialApiProxy = createProxyMiddleware({
  target: 'https://api.bilibili.com',
  changeOrigin: true,
  pathRewrite: {
    '^/api/proxy': ''  // 使用/api/proxy作为代理前缀
  },
  onProxyReq(proxyReq, req) {
    proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    proxyReq.setHeader('Referer', 'https://www.bilibili.com/');
    proxyReq.setHeader('Origin', 'https://www.bilibili.com');
  },
  onProxyRes(proxyRes, req, res) {
    proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
  },
  timeout: 8000
});

// 使用代理访问官方 API
app.use('/api/proxy/*', officialApiProxy);

// ========== 核心功能实现 ==========

// 支持的历史记录分区的 ID
const supportedRegionIds = [1, 3, 4, 5, 11, 13, 36, 119, 129, 155, 160, 165, 167, 168, 169, 170, 177, 188];

// ========== 封面缓存系统 ========= =
const CACHE_DIR = path.join(__dirname, 'cover_cache');
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7天缓存有效期
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
const memoryCache = new LRUCache({
  max: 100,
  ttl: 3600000 // 1小时内存缓存
});

// ====== 封面图片服务 ======
app.get('/api/cover/:bvid', async (req, res) => {
  const { bvid } = req.params;
  if (!/^BV\w{10}$/.test(bvid)) {
    return res.status(400).send('Invalid video ID');
  }
  try {
    // 内存缓存
    if (memoryCache.has(bvid)) {
      const { contentType, image } = memoryCache.get(bvid);
      res.type(contentType).send(image);
      return;
    }
    // 磁盘缓存
    const cachePath = path.join(CACHE_DIR, `${bvid}.cache`);
    if (fs.existsSync(cachePath)) {
      const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (Date.now() - cacheData.timestamp < CACHE_TTL) {
        memoryCache.set(bvid, {
          contentType: cacheData.contentType,
          image: Buffer.from(cacheData.image, 'base64')
        });
        res.type(cacheData.contentType)
           .send(Buffer.from(cacheData.image, 'base64'));
        return;
      }
    }
    // 获取原始封面
    const response = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      timeout: 4000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': `https://www.bilibili.com/video/${bvid}`
      }
    });
    if (response.data.code !== 0 || !response.data.data?.pic) {
      throw new Error('封面获取失败');
    }
    const coverUrl = response.data.data.pic.startsWith('http') 
      ? response.data.data.pic 
      : `https:${response.data.data.pic}`;
    const coverRes = await axios.get(coverUrl, {
      responseType: 'arraybuffer',
      timeout: 6000,
      headers: {
        'Referer': 'https://www.bilibili.com/'
      }
    });
    let coverData = coverRes.data;
    const contentType = coverRes.headers['content-type'] || 'image/jpeg';
    const cacheEntry = {
      timestamp: Date.now(),
      contentType,
      image: coverData.toString('base64'),
      etag: crypto.createHash('md5').update(coverData).digest('hex')
    };
    fs.writeFile(cachePath, JSON.stringify(cacheEntry), (err) => {
      if (err) console.error(`缓存写入失败: ${bvid}`, err);
    });
    memoryCache.set(bvid, {
      contentType,
      image: coverData
    });
    res.type(contentType).send(coverData);
  } catch (error) {
    console.error(`封面获取失败: ${bvid}`, error.message);
    const fallbackCover = path.join(__dirname, 'assets', 'default_cover.jpg');
    if (fs.existsSync(fallbackCover)) {
      res.type('image/jpeg').sendFile(fallbackCover);
    } else {
      res.status(500).send('封面不可用');
    }
  }
});

// 格式化视频数据 (统一标准格式)
const formatVideo = (video) => {
  const bvid = video.bvid || '';
  return {
    id: bvid,
    title: video.title.replace(/<[^>]+>/g, ''),
    cover: bvid ? `/api/cover/${bvid}` : 'https://i0.hdslb.com/bfs/archive/unknown_video_cover.jpg',
    author: video.owner?.name || video.author || video.ownerName || 'UP主',
    duration: formatDuration(video.duration),
    views: formatNumber(video.play || video.stat?.view),
    date: formatDate(video.pubdate || video.pubtime || video.ctime),
    isHot: !!video.isHot
  };
};

// 格式化时长 (秒转 MM:SS)
const formatDuration = (sec) => {
  if (!sec) return '0:00';
  const mins = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `${mins}:${seconds < 10 ? '0' : ''}${seconds}`;
};

// 格式化数字 (超过1万转换为x.x万)
const formatNumber = (num) => {
  const value = parseInt(num) || 0;
  if (value > 10000) return (value / 10000).toFixed(1) + '万';
  return value.toString();
};

// 格式化日期 (智能显示)
const formatDate = (timestamp) => {
  if (!timestamp) return '未知时间';
  const pubDate = new Date(timestamp * 1000);
  const now = Date.now();
  const diffDays = Math.floor((now - pubDate) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays}天前`;
  return pubDate.toLocaleDateString('zh-CN');
};

// ========== API端点实现 ==========

// 推荐视频 - 使用热门API
app.get('/api/recommend', async (req, res) => {
  try {
    const response = await axios.get('https://api.bilibili.com/x/web-interface/popular', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/'
      },
      timeout: 8000
    });
    
    if (response.data.code === 0 && Array.isArray(response.data.data?.list)) {
      const videos = response.data.data.list
        .slice(0, 20)
        .map(video => formatVideo({ ...video, isHot: true }));
      
      res.json(videos);
    } else {
      res.json(getFallbackRecommendations());
    }
  } catch (error) {
    console.error('获取推荐视频失败:', error);
    res.status(500).json(getFallbackRecommendations());
  }
});

// 热门视频 - 使用每周排行榜
app.get('/api/hot', async (req, res) => {
  try {
    const response = await axios.get('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/'
      },
      timeout: 8000
    });
    
    if (response.data.code === 0 && Array.isArray(response.data.data?.list)) {
      const videos = response.data.data.list
        .slice(0, 15)
        .map(video => formatVideo(video));
      
      res.json(videos);
    } else {
      res.json(getFallbackHotVideos());
    }
  } catch (error) {
    console.error('获取热门视频失败:', error);
    res.status(500).json(getFallbackHotVideos());
  }
});

// 最新动态 - 多分区聚合
app.get('/api/new', async (req, res) => {
  try {
    // 并行请求多个分区
    const requests = supportedRegionIds.slice(0, 3).map(rid => 
      axios.get(`https://api.bilibili.com/x/web-interface/dynamic/region?ps=10&rid=${rid}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Referer': 'https://www.bilibili.com/'
        },
        timeout: 5000
      })
    );
    
    const responses = await Promise.allSettled(requests);
    const videos = [];
    
    for (const response of responses) {
      if (response.status === 'fulfilled' && 
          response.value.data.code === 0 && 
          Array.isArray(response.value.data.data?.archives)) {
        videos.push(...response.value.data.data.archives.map(v => formatVideo(v)));
      }
    }
    
    // 去重并限制数量
    const uniqueVideos = [];
    const seen = new Set();
    
    for (const video of videos) {
      if (!seen.has(video.id)) {
        seen.add(video.id);
        uniqueVideos.push(video);
      }
    }
    
    res.json(uniqueVideos.slice(0, 12));
    
  } catch (error) {
    console.error('获取最新内容失败:', error);
    res.status(500).json(getFallbackLatestVideos());
  }
});

// 搜索视频
app.get('/api/search', async (req, res) => {
  const { q, page = 1 } = req.query;
  if (!q || q.trim().length < 1) {
    return res.status(400).json({ error: '缺少关键词参数' });
  }
  try {
    // 构造签名参数
    const wts = Math.floor(Date.now() / 1000);
    const params = {
      search_type: 'video',
      keyword: q,
      page,
      page_size: 15,
      wts,
      w_rid: generateWrid(q, page, wts)
    };
    const response = await axios.get(
      `https://api.bilibili.com/x/web-interface/search/type`,
      {
        params,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Referer': `https://search.bilibili.com/video?keyword=${encodeURIComponent(q)}`,
          'Origin': 'https://www.bilibili.com',
          'Cookie': `buvid3=${getRandomBuvid()}; sid=${crypto.randomBytes(8).toString('hex')}`
        },
        timeout: 8000
      }
    );
    
    if (response.data.code === 0 && Array.isArray(response.data.data?.result)) {
      const videos = response.data.data.result
        .filter(item => item.bvid)
        .map(item => {
          // 统一处理 duration 字段
          let durationInSeconds = 0;
          if (typeof item.duration === 'string' && item.duration.includes(':')) {
            const parts = item.duration.split(':');
            durationInSeconds =
              parseInt(parts[0]) * 60 +
              parseInt(parts[1]) +
              (parts[2] ? parseInt(parts[2]) : 0);
          } else if (!isNaN(item.duration)) {
            durationInSeconds = parseInt(item.duration);
          } else if (typeof item.duration === 'number') {
            durationInSeconds = item.duration;
          }
          return {
            id: item.bvid,
            title: item.title.replace(/<[^>]+>/g, ''),
            cover: item.pic?.startsWith('http') ? item.pic : `https:${item.pic}`,
            author: item.author,
            duration: formatDuration(durationInSeconds),
            views: formatNumber(item.play),
            date: formatDate(item.pubdate)
          };
        });
      res.json(videos);
    } else {
      res.json(getFallbackSearchResults(q));
    }
  } catch (error) {
    console.error('搜索失败:', error);
    res.status(500).json(getFallbackSearchResults(q));
  }
});

// 生成合规的 buvid3 值 (模拟设备指纹)
function getRandomBuvid() {
  const hex = crypto.randomBytes(10).toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}infoc`;
}

// 生成 w_rid 签名 (B站反爬核心机制)
function generateWrid(keyword, page, wts) {
  const salt = "ea85624dfcf12d7cc7b2b3a94ade1f05";
  const signString = `keyword=${keyword}&page=${page}&page_size=15&search_type=video&wts=${wts}${salt}`;
  return crypto.createHash('md5').update(signString).digest('hex');
}

// 获取视频详情
app.get('/api/video/:bvid', async (req, res) => {
  const bvid = req.params.bvid;
  
  // 基本验证
  if (!bvid || !/^BV\w{10}$/.test(bvid)) {
    return res.status(400).json({ error: '无效的视频ID格式' });
  }
  
  try {
    const response = await axios.get('https://api.bilibili.com/x/web-interface/view', {
      params: { bvid },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': `https://www.bilibili.com/video/${bvid}`
      },
      timeout: 8000
    });
    
    if (response.data.code === 0 && response.data.data) {
      const data = response.data.data;
      res.json({
        id: data.bvid,
        title: data.title,
        cover: `/api/cover/${data.bvid}`,
        author: data.owner?.name || 'UP主',
        duration: formatDuration(data.duration),
        views: formatNumber(data.stat?.view),
        likes: formatNumber(data.stat?.like),
        coins: formatNumber(data.stat?.coin),
        description: data.desc || '',
        publishTime: formatDate(data.pubdate)
      });
    } else {
      throw new Error(response.data.message || 'API错误');
    }
  } catch (error) {
    console.error('获取视频详情失败:', error);
    res.status(500).json({ 
      error: '无法获取视频信息，将重定向到来源页',
      videoUrl: `https://www.bilibili.com/video/${bvid}`
    });
  }
});

// ========== 后备数据 ==========

const getFallbackRecommendations = () => [
  { id: 'BV1if4y1L7aN', title: '2024必看震撼CG动画大合集', cover: 'https://i0.hdslb.com/bfs/archive/cd3f1e84cc7ef8970f3f572c22c12b3f9a7e3404.jpg', author: '电影盘点君', duration: '18:22', views: '88.5万', date: '3天前' },
  { id: 'BV1qk4y1z7zu', title: '全网最火BGM合集 - 2024热度榜', cover: 'https://i0.hdslb.com/bfs/archive/cbadf1bc7cbfa0bd59d1e10f52288c48c5a53f11.jpg', author: '音乐精选', duration: '15:45', views: '210.1万', date: '昨天' }
];

const getFallbackHotVideos = () => [
  { id: 'BV1Bk4y1z7Lc', title: 'AI工具使用指南2024：提升生产力的秘诀', cover: 'https://i0.hdslb.com/bfs/archive/0e6a84f9d9ab7f1961a8d95a7ea0c3a9d6a0e21a.jpg', author: '科技探秘', duration: '25:18', views: '356万', date: '2天前' }
];

const getFallbackLatestVideos = () => [
  { id: 'BV1fo4y1G7AS', title: 'Unity游戏开发：1小时创建3D角色', cover: 'https://i0.hdslb.com/bfs/archive/fe1bb3e3d5c94f9f3e7b8ec9ec698159d212b518.jpg', author: '游戏开发者', duration: '46:22', views: '12.3万', date: '1小时前' },
  { id: 'BV1kS421M7mC', title: '手机摄影技巧：如何拍出专业级照片', cover: 'https://i0.hdslb.com/bfs/archive/92a4ef1164a9965846c01431b0d93b85e4a15d7c.jpg', author: '摄影小课堂', duration: '15:33', views: '8.7万', date: '30分钟前' }
];

const getFallbackSearchResults = (q) => [
  { id: 'BV1GJ41197pA', title: `${q}完整教程 - 从入门到精通`, cover: 'https://i0.hdslb.com/bfs/archive/9293f16e2d6c077188fa4f515ca91bf2d8b2e3ba.jpg', author: '技术百科', duration: '28:15', views: '42.5万', date: '5天前' },
  { id: 'BV1Qo4y1G7xa', title: `${q}实战演示 - 最详细操作指南`, cover: 'https://i0.hdslb.com/bfs/archive/6f8b78cce563562a41b3f8289a1c5c6a2c54ce6d.jpg', author: '实战派', duration: '33:42', views: '19.3万', date: '3天前' }
];

// ========== 静态文件服务 - 特别针对Windows路径配置 ==========
const appRoot = 'H:\\Files\\bilibili\\bilibili-windows-app';
app.use(express.static(appRoot));

// 处理 SPA 路由: 所有路径返回 index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(appRoot, 'index.html'));
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => { // 监听所有网络接口
  console.log(`🚀 后端服务启动 http://localhost:${PORT}`);
  console.log(`📂 服务路径: ${appRoot}`);
  console.log('📡 推荐视频： /api/recommend');
  console.log('🔥 热门视频： /api/hot');
  console.log('🆕 最新动态： /api/new');
  console.log('🔍 搜索功能： /api/search?q={关键字}');
  console.log('📹 视频详情： /api/video/{bvid}');
  console.log('🔌 API代理：  /api/proxy/*');
  console.log('🌐 前端访问：  http://localhost:3001/index.html');
});

// 获取服务器状态
app.get("/api/status", async (req, res) => {
  try {
    // 检查各服务状态
    const [recStatus, searchStatus, coverStatus] = await Promise.all([
      checkServiceStatus("recommend"),
      checkServiceStatus("search"),
      checkServiceStatus("cover"),
    ]);
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const memoryUsage = totalMemory - freeMemory;
    // 计算缓存使用量
    let cacheSize = 0;
    if (fs.existsSync(CACHE_DIR)) {
      const files = fs.readdirSync(CACHE_DIR);
      files.forEach((file) => {
        const stats = fs.statSync(path.join(CACHE_DIR, file));
        cacheSize += stats.size;
      });
    }
    res.json({
      status: "ok",
      version: "v1.0.0",
      services: {
        recommendAPI: recStatus,
        searchAPI: searchStatus,
        coverAPI: coverStatus,
      },
      uptime: process.uptime(),
      cacheUsage: {
        size: cacheSize,
        formatted: (cacheSize / (1024 * 1024)).toFixed(2) + " MB",
      },
      memory: {
        total: (totalMemory / (1024 * 1024)).toFixed(2) + " MB",
        used: (memoryUsage / (1024 * 1024)).toFixed(2) + " MB",
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "无法获取服务状态",
    });
  }
});
// 辅助函数：检查服务状态
async function checkServiceStatus(serviceType) {
  let url;
  switch (serviceType) {
    case "recommend":
      url = "https://api.bilibili.com/x/web-interface/popular";
      break;
    case "search":
      url = "https://api.bilibili.com/x/web-interface/search/type";
      break;
    case "cover":
      url = `https://api.bilibili.com/cover/my`;
      break;
    default:
      return false;
  }
  try {
    const response = await axios.get(url, {
      timeout: 3000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Referer: "https://www.bilibili.com/",
      },
    });
    return response.status === 200;
  } catch (e) {
    return false;
  }
}

// 清空缓存
app.get("/api/clear_cache", (req, res) => {
  try {
    // 清空内存缓存
    memoryCache.clear();
    // 清空磁盘缓存
    if (fs.existsSync(CACHE_DIR)) {
      fs.rmSync(CACHE_DIR, { recursive: true, force: true });
      fs.mkdirSync(CACHE_DIR);
    }
    res.json({
      success: true,
      message: "缓存已成功清理",
      cleanedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `清理失败: ${error.message}`,
    });
  }
});

// 验证码路由
app.get('/api/captcha', (req, res) => {
  const captcha = generateCaptcha();
  const sid = crypto.randomBytes(8).toString('hex'); // 生成会话ID
  sessions[sid] = { captcha, timestamp: Date.now() };
  // 设置响应头禁止缓存
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  // 返回验证码文本（实际应用应生成图片）
  res.type('text/plain').send(captcha);
});

// 用户注册
app.post('/api/register', async (req, res) => {
  const { username, password, email, captcha } = req.body;
  // 验证码检查（示例）
  if (!captcha) {
    return res.status(400).json({ error: '请输入验证码' });
  }
  // 简单的验证逻辑（实际应用应更严谨）
  if (!username || username.length < 2 || username.length > 16) {
    return res.status(400).json({ error: '用户名必须为2-16个字符' });
  }
  if (!password || password.length < 8 || password.length > 20) {
    return res.status(400).json({ error: '密码必须为8-20位' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  // 检查用户名是否已被使用
  if (users.some(u => u.username === username)) {
    return res.status(400).json({ error: '用户名已被注册' });
  }
  // 密码加密
  const hashedPassword = await bcrypt.hash(password, 10);
  // 创建新用户
  const newUser = {
    id: crypto.randomBytes(8).toString('hex'),
    username,
    password: hashedPassword,
    email,
    createdAt: new Date().toISOString(),
    avatar: 'https://i0.hdslb.com/bfs/face/member/noface.jpg'
  };
  users.push(newUser);
  // 生成JWT令牌
  const token = jwt.sign(
    { userId: newUser.id, username: newUser.username },
    JWT_SECRET,
    { expiresIn: '1d' }
  );
  // 返回响应（不包括密码）
  const userResponse = { ...newUser };
  delete userResponse.password;
  res.status(201).json({
    token,
    user: userResponse
  });
});

// 用户登录
app.post('/api/login', async (req, res) => {
  const { username, password, remember } = req.body;
  // 查找用户
  const user = users.find(u => u.username === username);
  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  // 验证密码
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  // 生成JWT令牌（记住我功能持续时间较长）
  const token = jwt.sign(
    { userId: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: remember ? '7d' : '1d' }
  );
  // 返回响应（不包括密码）
  const userResponse = { ...user };
  delete userResponse.password;
  res.json({
    token,
    user: userResponse
  });
});

// 认证中间件
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      next();
    } catch (error) {
      res.status(401).json({ error: '无效的认证令牌' });
    }
  } else {
    res.status(401).json({ error: '未提供认证令牌' });
  }
};

// 获取用户信息
app.get('/api/user', authenticate, (req, res) => {
  // 从数据库查找用户
  const user = users.find(u => u.id === req.user.userId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  // 返回响应（不包括密码）
  const userResponse = { ...user };
  delete userResponse.password;
  res.json(userResponse);
});

// 缓存清理任务 (每日执行)
setInterval(() => {
  fs.readdir(CACHE_DIR, (err, files) => {
    if (err) return;
    const now = Date.now();
    files.forEach(file => {
      if (file.endsWith('.cache')) {
        const filePath = path.join(CACHE_DIR, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > CACHE_TTL) {
          fs.unlink(filePath, err => {
            if (!err) memoryCache.delete(file.replace('.cache', ''));
          });
        }
      }
    });
  });
  console.log(`[${new Date().toISOString()}] 执行定期缓存清理`);
}, 24 * 60 * 60 * 1000); // 每天清理一次
