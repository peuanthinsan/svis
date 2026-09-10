function blocksWebsite(hostHeader){
 if(typeof hostHeader!=='string')return false;
 try{return new URL('http://'+hostHeader).hostname.toLowerCase().replace(/\.$/,'')==='api2.songdeegps.com';}catch{return false;}
}
module.exports={blocksWebsite};
