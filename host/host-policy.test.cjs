const test=require('node:test');const assert=require('node:assert/strict');
const {blocksWebsite}=require('./host-policy.cjs');
test('api2 is blocked independently of hostname case, port, and trailing dot',()=>{
 for(const host of ['api2.songdeegps.com','API2.SONGDEEGPS.COM','api2.songdeegps.com:8081','api2.songdeegps.com.:8081'])assert.equal(blocksWebsite(host),true);
});
test('the SVIS domain and direct IP access stay available',()=>{
 for(const host of ['svis.songdeegps.com','172.24.8.104:8081','127.0.0.1:8081','203.151.66.234:8081'])assert.equal(blocksWebsite(host),false);
});
