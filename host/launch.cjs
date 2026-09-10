const fs=require('node:fs');const path=require('node:path');
const configPath=process.env.SVIS_CONFIG;
if(!configPath)throw new Error('SVIS_CONFIG must name the protected runtime configuration');
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const allowed=new Set(['DATABASE_URL','JWT_SECRET','EMAIL_ENABLED','SENDGRID_API_KEY','SENDGRID_FROM_EMAIL','BLOB_READ_WRITE_TOKEN','CRON_SECRET','LOGIN_RATE_LIMIT_SECRET','NODE_ENV','HOST','PORT','TZ','SVIS_STAGE','SVIS_PUBLIC_DIR','SVIS_PROXY_SECRET']);
for(const [key,value]of Object.entries(config)){if(!allowed.has(key))throw new Error('Unexpected runtime setting: '+key);process.env[key]=String(value);}
require(path.join(__dirname,'../dist/server.cjs'));
