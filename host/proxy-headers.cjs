const {timingSafeEqual}=require('node:crypto');const {isIP}=require('node:net');
function single(value){return Array.isArray(value)?value[0]:value;}
function trustedClientIp(headers,peer,secret){
 // Internet/LAN clients connect directly. Only local reverse proxies can
 // supply forwarding metadata; remote callers cannot spoof rate-limit keys.
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer))return peer||'unknown';
 const supplied=single(headers['x-svis-proxy-secret']);
 const trusted=!!secret&&typeof supplied==='string'&&Buffer.byteLength(secret)===Buffer.byteLength(supplied)&&timingSafeEqual(Buffer.from(secret),Buffer.from(supplied));
 const forwarded=single(headers['x-svis-client-ip']);
 if(trusted&&forwarded&&isIP(forwarded))return forwarded;
 // ngrok appends its observed client at the right of the forwarding chain.
 const chain=String(single(headers['x-forwarded-for'])||'').split(',').map(s=>s.trim());
 const ingress=chain.at(-1);return ingress&&isIP(ingress)?ingress:peer||'unknown';
}
function normalizeProxyHeaders(req,secret){
 const ip=trustedClientIp(req.headers,req.socket.remoteAddress,secret);
 delete req.headers['x-svis-proxy-secret'];delete req.headers['x-svis-client-ip'];
 delete req.headers['x-real-ip'];req.headers['x-vercel-forwarded-for']=ip;req.headers['x-forwarded-for']=ip;
}
module.exports={trustedClientIp,normalizeProxyHeaders};
