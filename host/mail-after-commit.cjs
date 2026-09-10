const mail=require('@sendgrid/mail');
const {afterCommit}=require('./pg-neon.cjs');
module.exports={
 setApiKey:(...args)=>mail.setApiKey(...args),
 send:(...args)=>afterCommit(()=>mail.send(...args)),
};
