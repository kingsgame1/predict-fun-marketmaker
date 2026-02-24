/**
 * Web Server - 提供客户端界面和 API
 */

import express from 'express';
import { open } from 'open';
import { PredictMarketMakerBot } from './index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WebServer {
  private app: express.Application;
  private bot?: PredictMarketMakerBot;
  private port: number;
  private server?: any;
  private stats = {
    totalOrders: 0,
    successOrders: 0,
    failedOrders: 0,
    markets: 0,
    activeOrders: 0,
    startTime: null as Date | null
  };

  constructor(port: number = 3000) {
    this.port = port;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../public')));
  }

  private setupRoutes() {
    // 主页
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    });

    // API: 获取状态
    this.app.get('/api/status', (req, res) => {
      res.json({
        running: this.bot !== undefined,
        stats: this.stats
      });
    });

    // API: 启动做市商
    this.app.post('/api/start', async (req, res) => {
      try {
        if (this.bot) {
          return res.json({ success: false, message: '做市商已在运行中' });
        }

        console.log('🚀 Starting Market Maker...\n');
        this.bot = new PredictMarketMakerBot();
        await this.bot.initialize();
        await this.bot.start();

        this.stats.startTime = new Date();
        this.stats.markets = this.bot.getSelectedMarketsCount();

        res.json({ success: true, message: '做市商启动成功' });
      } catch (error: any) {
        console.error('启动失败:', error);
        res.json({ success: false, message: error.message || '启动失败' });
      }
    });

    // API: 停止做市商
    this.app.post('/api/stop', async (req, res) => {
      try {
        if (!this.bot) {
          return res.json({ success: false, message: '做市商未运行' });
        }

        await this.bot.stop();
        this.bot = undefined;
        this.stats.startTime = null;

        res.json({ success: true, message: '做市商已停止' });
      } catch (error: any) {
        console.error('停止失败:', error);
        res.json({ success: false, message: error.message || '停止失败' });
      }
    });

    // 404
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`\n🌐 Web Server running at http://localhost:${this.port}`);
        console.log(`📱 Client interface: http://localhost:${this.port}\n`);

        // 自动打开浏览器
        open(`http://localhost:${this.port}`).catch(err => {
          console.warn('⚠️  Could not open browser automatically:', err.message);
          console.log('👆 Please open the URL above in your browser\n');
        });

        resolve();
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} is already in use`));
        } else {
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('🌐 Web Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  updateStats(updates: Partial<typeof this.stats>) {
    this.stats = { ...this.stats, ...updates };
  }
}

// 启动服务器
async function main() {
  const port = 3000;
  const server = new WebServer(port);

  try {
    await server.start();
    console.log('✅ Server ready!\n');
    console.log('💡 Press Ctrl+C to stop\n');
  } catch (error: any) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

// 仅在直接运行时启动
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { WebServer };
