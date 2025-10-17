const https = require('https');
const fs = require('fs');
const path = require('path');

// 嘗試從 .env 載入環境變數
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        // 移除引號
        value = value.replace(/^['"](.*)['"]$/, '$1');
        process.env[key] = value;
      }
    });
  }
} catch (error) {
  console.log('⚠️  無法讀取 .env 文件，使用環境變數或預設值');
}

// 從環境變數或 .env 載入配置（優先順序: 環境變數 > .env 文件 > 預設值）
const API_URL = process.env.API_URL || 'https://common-api.sagano.linktivity.io/v1/inventories/2025-11-03/services/37?product_id=51&base_booking_id=';
const BOOK_URL = process.env.BOOK_URL || 'https://ars-saganokanko.triplabo.jp/activity/zt/LINKTIVITY-YRBTL/';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'YOUR_DISCORD_WEBHOOK_URL_HERE';
const TARGET_CAR = '2号車';

// 配置
const CHECK_INTERVAL = 20 * 60 * 1000; // 5 分鐘（毫秒）
const MAX_RUNTIME = 5.9 * 60 * 60 * 1000; // 5.9 小時（留一點緩衝避免超時）

function fetchInventory() {
  return new Promise((resolve, reject) => {
    https.get(API_URL, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function sendDiscordNotification(availableSeats) {
  if (DISCORD_WEBHOOK_URL === 'YOUR_DISCORD_WEBHOOK_URL_HERE') {
    console.log('⚠️  Discord Webhook URL 未設定，跳過推播');
    return Promise.resolve();
  }

  const url = new URL(DISCORD_WEBHOOK_URL);

  const seatList = availableSeats
    .map(seat => `• Group ${seat.seat_group_id} Seat ${seat.seat_id}`)
    .join('\n');

  const payload = JSON.stringify({
    embeds: [{
      title: '🎯 火車座位可用通知',
      description: `發現 **${availableSeats.length}** 個可安排的空位！`,
      color: 3066993, // 綠色
      fields: [
        {
          name: '車廂',
          value: TARGET_CAR,
          inline: true
        },
        {
          name: '可用座位',
          value: seatList,
          inline: false
        },
        {
          name: '檢查時間',
          value: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
          inline: false
        },
        {
          name: '下訂網址',
          value: BOOK_URL,
          inline: false
        }
      ]
    }]
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('✅ Discord 通知已發送');
          resolve();
        } else {
          console.error(`❌ Discord 推播失敗: ${res.statusCode}`);
          reject(new Error(`Discord webhook failed: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error('❌ Discord 推播錯誤:', error.message);
      reject(error);
    });

    req.write(payload);
    req.end();
  });
}

function checkAvailableSeats(data) {
  const targetCar = data.car_inventories?.find(
    car => car.physical_car_name === TARGET_CAR
  );

  if (!targetCar) {
    console.log(`找不到車廂: ${TARGET_CAR}`);
    return;
  }

  // 先篩選符合基本條件的座位
  const matchedSeats = targetCar.arrangements.filter(seat => {
    // 條件 1: seat_group_id 為偶數（字串轉數字）
    const seatGroupId = parseInt(seat.seat_group_id, 10);
    const isEvenGroup = !isNaN(seatGroupId) && seatGroupId % 2 === 0;

    // 條件 2: seat_id 為 A 或 D
    const isAorD = seat.seat_id === 'A' || seat.seat_id === 'D';

    // 條件 3: reservation_state 為 VACANT（即沒有被預訂）
    const isVacant = seat.reservation_state === 'VACANT';

    return isEvenGroup && isAorD && isVacant;
  });

  // 區分 ARRANGEABLE 和非 ARRANGEABLE 的座位
  const availableSeats = [];
  const unavailableSeats = [];

  matchedSeats.forEach(seat => {
    if (seat.arrangement_state === 'ARRANGEABLE') {
      availableSeats.push(seat);
    } else {
      unavailableSeats.push(seat);
    }
  });

  console.log(`[${new Date().toISOString()}] 檢查結果:`);
  console.log(`  目標車廂: ${TARGET_CAR}`);
  console.log(`  符合條件且可安排的座位數: ${availableSeats.length}`);

  // 警告：符合條件但不可安排的座位
  if (unavailableSeats.length > 0) {
    console.warn(`\n⚠️  提示: 發現 ${unavailableSeats.length} 個座位符合條件但 arrangement_state 不是 ARRANGEABLE:`);
    unavailableSeats.forEach(seat => {
      console.warn(`  - Group ${seat.seat_group_id} Seat ${seat.seat_id} (State: ${seat.arrangement_state})`);
    });
  }

  // 主要通知：可用座位 >= 4
  if (availableSeats.length >= 4) {
    console.log(`\n🎯 發現 ${availableSeats.length} 個可安排的空位！`);
    availableSeats.forEach(seat => {
      console.log(`  - Group ${seat.seat_group_id} Seat ${seat.seat_id} (${seat.arrangement_state})`);
    });

    // 發送 Discord 通知
    sendDiscordNotification(availableSeats).catch(err => {
      console.error('Discord 通知發送失敗:', err.message);
    });
  }

  return availableSeats;
}

async function monitor() {
  try {
    const data = await fetchInventory();
    checkAvailableSeats(data);
  } catch (error) {
    console.error('錯誤:', error.message);
  }
}

async function startMonitoring() {
  const startTime = Date.now();
  let checkCount = 0;

  console.log('========================================');
  console.log('🚀 監控服務啟動');
  console.log(`📅 開始時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  console.log(`🚂 目標車廂: ${TARGET_CAR}`);
  console.log(`⏱️  檢查間隔: ${CHECK_INTERVAL / 1000} 秒`);
  console.log(`⏳ 最大運行時間: ${MAX_RUNTIME / 1000 / 60 / 60} 小時`);
  console.log('========================================\n');

  // 立即執行第一次檢查
  await monitor();
  checkCount++;

  // 設定定時檢查
  const intervalId = setInterval(async () => {
    const elapsed = Date.now() - startTime;

    // 檢查是否超過最大運行時間
    if (elapsed >= MAX_RUNTIME) {
      clearInterval(intervalId);
      console.log('\n========================================');
      console.log('⏰ 已達最大運行時間，優雅退出');
      console.log(`📊 總共檢查次數: ${checkCount}`);
      console.log(`📅 結束時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
      console.log('========================================');
      process.exit(0);
    }

    await monitor();
    checkCount++;
  }, CHECK_INTERVAL);

  // 處理 Ctrl+C 優雅退出
  process.on('SIGINT', () => {
    clearInterval(intervalId);
    console.log('\n\n========================================');
    console.log('🛑 收到中斷信號，停止監控');
    console.log(`📊 總共檢查次數: ${checkCount}`);
    console.log('========================================');
    process.exit(0);
  });
}

// 啟動持續監控
startMonitoring();
