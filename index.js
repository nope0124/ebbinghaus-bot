const { WebClient } = require('@slack/web-api');
const moment = require('moment-timezone');
const admin = require('firebase-admin');
const request = require('request')
const express = require('express');
const app = express();
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const remindIntervals = [560, 280, 140, 70, 35, 14, 7, 3, 1];

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.DATABASE_URL,
});

const db = admin.database();

app.get('/', (req, res) => {
  res.status(200).send('OK');
})

// ユーザー認証かつアクセストークン登録
// app.get('/', (req, res) => {
//     const code = req.query["code"];

//     // 認可コードを使って、アクセストークンをリクエストする
//     request({
//         url: "https://slack.com/api/oauth.access",
//         method: "POST",
//         form: {
//             client_id: process.env.SLACK_CLIENT_ID,
//             client_secret: process.env.SLACK_CLIENT_SECRET,
//             code: code,
//             redirect_uri: process.env.REDIRECT_URI
//         }
//     }, async (error, response, body) => {
//         // レスポンスからアクセストークンを取得する
//         const param = JSON.parse(body);
//         console.log(param);
//         const userId = param['user_id'];
//         const accessToken = param['access_token'];
//         const web = new WebClient(accessToken);
//         const channels = await web.conversations.list({ types: 'im' });
//         var selfDmChannelId = "";
//         var botDmChannelId = "";
        
//         for (const channel of channels.channels) {
//           if (channel.user == userId) {
//             selfDmChannelId = channel.id;
//           }
//           if (channel.user == process.env.SLACK_BOT_ID) {
//             botDmChannelId = channel.id;
//           }
//         }

//         console.log("Self DM ChannelID: " + selfDmChannelId);
//         console.log("Bot DM ChannelID: " + botDmChannelId);
        
//         if (selfDmChannelId == "" || botDmChannelId == "") {
//           res.status(500).send("NG");
//         } else {
//           const dateRef = db.ref('userInfos/' + userId);
//           dateRef.set({
//             userId: userId,
//             accessToken: accessToken,
//             selfDmChannelId: selfDmChannelId,
//             botDmChannelId: botDmChannelId,
//           });
//           res.status(200).send('OK');
//         }
//     })
// })
app.get('/oauth_redirect', (req, res) => {
    const code = req.query["code"];

    // 認可コードを使って、アクセストークンをリクエストする
    request({
        url: "https://slack.com/api/oauth.access",
        method: "POST",
        form: {
            client_id: process.env.SLACK_CLIENT_ID,
            client_secret: process.env.SLACK_CLIENT_SECRET,
            code: code,
            redirect_uri: process.env.REDIRECT_URI
        }
    }, async (error, response, body) => {
        if (error) {
            console.error('Request error:', error);
            return res.status(500).send("Error requesting access token");
        }

        try {
            // レスポンスからアクセストークンを取得する
            const param = JSON.parse(body);
            console.log(param);
            if (!param.access_token) {
                return res.status(500).send("Invalid response from OAuth endpoint");
            }
            const userId = param['user_id'];
            const accessToken = param['access_token'];
            const web = new WebClient(accessToken);

            try {
                const channels = await web.conversations.list({ types: 'im' });
                var selfDmChannelId = "";
                var botDmChannelId = "";
                
                for (const channel of channels.channels) {
                    if (channel.user == userId) {
                        selfDmChannelId = channel.id;
                    }
                    if (channel.user == process.env.SLACK_BOT_ID) {
                        botDmChannelId = channel.id;
                    }
                }

                console.log("Self DM ChannelID: " + selfDmChannelId);
                console.log("Bot DM ChannelID: " + botDmChannelId);
                
                if (selfDmChannelId == "" || botDmChannelId == "") {
                    res.status(500).send("DM Channel ID not found");
                } else {
                    const dateRef = db.ref('userInfos/' + userId);
                    dateRef.set({
                        userId: userId,
                        accessToken: accessToken,
                        selfDmChannelId: selfDmChannelId,
                        botDmChannelId: botDmChannelId,
                    });
                    res.status(200).send('OK');
                }
            } catch (apiError) {
                console.error('API error:', apiError);
                res.status(500).send("Error fetching conversation list");
            }
        } catch (parseError) {
            console.error('JSON parsing error:', parseError);
            res.status(500).send("Error parsing JSON response");
        }
    });
});


function formatDate(date) {
  return moment(date).tz("Asia/Tokyo").format('YYYY-MM-DD');
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function registerMessage(userId, date, interval, message) {
  const dateRef = db.ref('messages/' + userId + '/' + date + '/' + interval);
  const newMessageRef = dateRef.push();
  newMessageRef.set(message);
}

// 昨日のメッセージを登録する
async function registerYesterdayMessages(userId, selfDmChannelId, accessToken) {
  // 昨日の日付を計算
  const yesterdayStart = moment().tz("Asia/Tokyo").subtract(1, 'days').startOf('day').unix();
  const yesterdayEnd = moment().tz("Asia/Tokyo").subtract(1, 'days').endOf('day').unix();
    
  // ここでhistory.messagesをDBに登録
  const web = new WebClient(accessToken);
  const history = await web.conversations.history({
    channel: selfDmChannelId,
    oldest: yesterdayStart.toString(),
    latest: yesterdayEnd.toString(),
    inclusive: true
  });

  // 日付を計算
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  remindIntervals.forEach(interval => {
    const futureDate = addDays(yesterday, interval);
    history.messages.forEach(message => {
      const newMessage = {
        text: message.text,
        user: message.user,
        ts: message.ts
      };
      registerMessage(userId, formatDate(futureDate), interval, newMessage);
    });
  })
}

// ユーザーにメッセージを送信する
async function sendMessages(userId, botDmChannelId) {
  const today = new Date();
  
  // かわいい
  await slackClient.chat.postMessage({
    channel: botDmChannelId,
    text: "Pちゃんおはよう！" + moment(today).tz("Asia/Tokyo").format('YYYY/MM/DD') + "のリマインド一覧だよ！\n" + "今日も一日頑張ろうね！！"
  });
  
  for (let interval of remindIntervals) {
    const ref = db.ref('messages/' + userId + '/' + formatDate(today) + '/' + interval);
    try {
      // タイムスタンプで昇順にソート
      const query = ref.orderByChild('ts');
      const snapshot = await query.once('value');
      if (snapshot.exists()) {
        const messages = snapshot.val();
        const messagesArray = Object.keys(messages).map(key => ({
          ...messages[key],
          key
        })).sort((a, b) => a.ts - b.ts);
        
        // いつの投稿かを明示する
        await slackClient.chat.postMessage({
          channel: botDmChannelId,
          text: "---------- " + moment(addDays(today, -interval)).tz("Asia/Tokyo").format('YYYY/MM/DD') + " (" + interval + "日前) ----------"
        });
        
        // リマインドする
        for (const message of messagesArray) {
          if (message.user == userId) {
            await slackClient.chat.postMessage({
              channel: botDmChannelId,
              text: message.text
            });
            console.log(message);
          }
        }
      } else {
        console.log('No messages found for the given date.');
      }
    } catch (error) {
      console.error('Error fetching messages:', error);
    }
  }
}

// 1日前までの全てのメッセージを一括で登録する、内部でfor文を回す
// 注: 0:00~8:59までの間には実行しない
async function registerAllMessages() {
  console.log("Run registerAllMessages.");
  const ref = db.ref('userInfos');
  const snapshot = await ref.once('value');
  if (snapshot.exists()) {
    const userInfos = snapshot.val();
    const userInfosArray = Object.keys(userInfos).map(key => ({
      ...userInfos[key],
      key
    }));
    // ユーザーごとに処理を行う
    for (const userInfo of userInfosArray) {
      const userId = userInfo['userId'];
      const selfDmChannelId = userInfo['selfDmChannelId'];
      const botDmChannelId = userInfo['botDmChannelId'];
      const accessToken = userInfo['accessToken'];
      
      const web = new WebClient(accessToken);
      const history = await web.conversations.history({ channel: selfDmChannelId });
      const todayStart = moment().tz("Asia/Tokyo").startOf('day').unix();
      // const yesterdayStart = moment().tz("Asia/Tokyo").subtract(1, 'days').startOf('day').unix();
      
      remindIntervals.forEach(interval => {
        for (let message of history.messages) {
          if (message.ts >= todayStart) continue;
          const futureDate = addDays(message.ts*1000, interval);
          const newMessage = {
            text: message.text,
            user: message.user,
            ts: message.ts
          };
          registerMessage(userId, formatDate(futureDate), interval, newMessage);
        }
      })
    }
  }
}

// デバッグ用、特定ユーザーのメッセージを登録する
async function debugRegisterMessages(targetUserId = process.env.NOPE_USER_ID) {
  console.log("Run debugRegisterMessages: " + targetUserId);
  const userRef = db.ref('userInfos/' + targetUserId);
  const snapshot = await userRef.once('value');
  if (snapshot.exists()) {
    const userInfo = snapshot.val();
    
    const userId = userInfo['userId'];
    const selfDmChannelId = userInfo['selfDmChannelId'];
    const botDmChannelId = userInfo['botDmChannelId'];
    const accessToken = userInfo['accessToken'];

    const web = new WebClient(accessToken);
    const history = await web.conversations.history({ channel: selfDmChannelId });
    const todayStart = moment().tz("Asia/Tokyo").startOf('day').unix();

    remindIntervals.forEach(interval => {
      for (let message of history.messages) {
        const futureDate = addDays(message.ts*1000, interval);
        const newMessage = {
          text: message.text,
          user: message.user,
          ts: message.ts
        };
        const dateRef = db.ref('debugMessages/' + userId + '/' + formatDate(futureDate) + '/' + interval);
        const newMessageRef = dateRef.push();
        newMessageRef.set(newMessage);
      }
    })
  }
}

// デバッグ用、特定ユーザーのメッセージを送信する
async function debugSendMessages(targetUserId = process.env.NOPE_USER_ID) {
  console.log("Run debugSendMessages: " + targetUserId);
  const today = new Date();
  const userRef = db.ref('userInfos/' + targetUserId);
  const snapshot = await userRef.once('value');
  if (snapshot.exists()) {
    const userInfo = snapshot.val();
    
    const userId = userInfo['userId'];
    const selfDmChannelId = userInfo['selfDmChannelId'];
    const botDmChannelId = userInfo['botDmChannelId'];
    const accessToken = userInfo['accessToken'];
    
    // かわいい
    await slackClient.chat.postMessage({
      channel: botDmChannelId,
      text: "Pちゃんおはよう！" + moment(today).tz("Asia/Tokyo").format('YYYY/MM/DD') + "のリマインド一覧だよ！\n" + "今日も一日頑張ろうね！！"
    });
    
    for (let interval of remindIntervals) {
      const ref = db.ref('debugMessages/' + userId + '/' + formatDate(today) + '/' + interval);
      try {
        // タイムスタンプで昇順にソート
        const query = ref.orderByChild('ts');
        const snapshot = await query.once('value');
        if (snapshot.exists()) {
          const messages = snapshot.val();
          const messagesArray = Object.keys(messages).map(key => ({
            ...messages[key],
            key
          })).sort((a, b) => a.ts - b.ts);

          // いつの投稿かを明示する
          await slackClient.chat.postMessage({
            channel: botDmChannelId,
            text: "---------- " + moment(addDays(today, -interval)).tz("Asia/Tokyo").format('YYYY/MM/DD') + " (" + interval + "日前) ----------"
          });

          // リマインドする
          for (const message of messagesArray) {
            await slackClient.chat.postMessage({
              channel: botDmChannelId,
              text: message.text
            });
            console.log(message);
          }
        } else {
          console.log('No messages found for the given date.');
        }
      } catch (error) {
        console.error('Error fetching messages:', error);
      }
    }
  }
}

// 定期実行
function scheduleDaily(hour, minute, taskFunction) {
  const now = new Date();
  const then = new Date();

  then.setHours(hour, minute, 0, 0);

  if (now > then) {
    then.setDate(then.getDate() + 1);  // 次の日に設定
  }

  const timeout = then.getTime() - now.getTime();

  setTimeout(() => {
    taskFunction();
    scheduleDaily(hour, minute, taskFunction);  // 翌日も同じ時間に設定、デバッグ用に短縮
  }, timeout);
}

scheduleDaily(0, 0, async () => {
  console.log('Run scheduleDaily.');
  // ユーザー一覧を取得
  const ref = db.ref('userInfos');
  const snapshot = await ref.once('value');
  if (snapshot.exists()) {
    const userInfos = snapshot.val();
    const userInfosArray = Object.keys(userInfos).map(key => ({
      ...userInfos[key],
      key
    }));
    // ユーザーごとに処理を行う
    for (const userInfo of userInfosArray) {
      const userId = userInfo['userId'];
      const selfDmChannelId = userInfo['selfDmChannelId'];
      const botDmChannelId = userInfo['botDmChannelId'];
      const accessToken = userInfo['accessToken'];
      
      // 昨日の投稿を保存
      registerYesterdayMessages(userId, selfDmChannelId, accessToken);
      // リマインド一覧を送信
      sendMessages(userId, botDmChannelId);
    }
  }
});

app.listen(3000, async () =>{
  console.log('HTTP Server(3000) is running.');
  
  // デバッグ用関数を置く
  // debugRegisterMessages();
  // debugSendMessages();
  // registerAllMessages();
  
  // const channels = await web.conversations.list({ types: 'im' });
  // for (const channel of channels.channels) {
  //   console.log(channel.id);
  // }
});
