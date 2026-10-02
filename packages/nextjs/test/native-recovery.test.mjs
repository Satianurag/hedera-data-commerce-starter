import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
/** Audit reproductions: exact production TS transpiled without edits; real on-disk
 * SQLite. Authenticated session and verified seller quote are fixtures; all RPC and
 * Mirror replies are mocked. No network requests, wallets, or funds are used. */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { Interface } = require('ethers');
const root = path.resolve(__dirname, '../../..');
const buyer = '0x0000000000000000000000000000000000000011';
const seller = '0x0000000000000000000000000000000000000022';
const contract = '0x0000000000000000000000000000000000000033';
const fundingId = 'a'.repeat(32), refundId = 'b'.repeat(32);
const hash = '0x' + 'c'.repeat(64), fundingHash = '0x' + 'd'.repeat(64);
const termsHash = '0x' + 'e'.repeat(64);
const now = Math.floor(Date.now()/1000);
const abi = [
 'function fund(address seller,uint64 quoteExpiresAt,uint64 refundAfter,bytes32 termsHash) payable returns (uint256)',
 'function usedTermsHash(address buyer,bytes32 termsHash) view returns (bool)',
 'function escrows(uint256 id) view returns (address buyer,address seller,uint256 amount,uint64 quoteExpiresAt,uint64 refundAfter,bytes32 termsHash,uint8 state)',
 'function approve(uint256 id)', 'function withdraw(uint256 id)', 'function refund(uint256 id)',
 'event Funded(uint256 indexed id,address indexed buyer,address seller,uint256 amount,uint64 quoteExpiresAt,uint64 refundAfter,bytes32 indexed termsHash)',
 'event Approved(uint256 indexed id,address indexed buyer)',
 'event Released(uint256 indexed id,address indexed seller,address to,uint256 amount)',
 'event Refunded(uint256 indexed id,address indexed buyer,address to,uint256 amount)',
];
const iface = new Interface(abi);
const runtime = '0x6000';
const runtimeHash = createHash('sha256').update(Buffer.from('6000','hex')).digest('hex');
const origin = new URL('http://localhost:3000');
const session = {sessionId: '1'.repeat(32), ownerAddress: buyer, expiresAt: now+3600};
function load(name, overrides) {
 const filename = path.join(root, 'packages/nextjs/lib', name+'.ts');
 const js = ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const loaded = {exports:{}};
 const req = id => Object.hasOwn(overrides,id) ? overrides[id] : require(id);
 vm.runInThisContext('(function(require,module,exports){'+js+'\n})',{filename})(req,loaded,loaded.exports);
 return loaded.exports;
}
class CommerceIssue extends Error { constructor(message,status) {super(message);this.status=status;} }
async function fixture() {
 const hedera = await import(path.join(root,'packages/neuron-hedera/dist/index.js'));
 const directory=fs.mkdtempSync(require('node:os').tmpdir()+'/native-journal-');fs.chmodSync(directory,0o700);
 const databasePath=path.join(directory,'customer.sqlite');
 const db = new Database(databasePath);db.pragma('journal_mode = WAL');db.pragma('synchronous = FULL');
 db.exec('CREATE TABLE customer_sessions(session_id TEXT,owner_address TEXT,origin TEXT,revoked_at INTEGER,expires_at INTEGER)');
 db.prepare('INSERT INTO customer_sessions VALUES(?,?,?,NULL,?)').run(session.sessionId,buyer,origin.origin,session.expiresAt);
 const verified = {terms:{buyerAddress:buyer,sellerAddress:seller,sellerAccountId:'0.0.22',escrowAddress:contract,escrowContractId:'0.0.33',amountTinybar:'100',expiresAt:String(now+600),refundAfter:String(now+1200)},termsHash:'0x'+'f'.repeat(64),sellerPublicKey:'02'+'1'.repeat(64)};
 const api = load('customer-funding', {
  './commerce-guards':load('commerce-guards',{'./customer-auth':{customerAccessAllowed:()=>true}}),
  './customer-wallet-attempts':load('customer-wallet-attempts',{'./customer-commerce':{CommerceIssue}}),
  './customer-auth':{withCustomerDatabase:work=>work(db)},
  './customer-commerce':{CommerceIssue,reverifyReviewedCommerceIntent:async(_session,_origin,id)=>({intent:{id},verified})},
  '@neuron/hedera':hedera,
 });
 api.customerFundingHistory(session,origin,0);
 api.latestCustomerRefund(session,origin);
 const fundingTx = {from:buyer,to:contract,value:'0xe8d4a51000',data:iface.encodeFunctionData('fund',[seller,now-1200,now-600,termsHash])};
 const refundTx = {from:buyer,to:contract,value:'0x0',data:iface.encodeFunctionData('refund',[1])};
 db.prepare(`INSERT INTO customer_funding_intents
 (id,quote_intent_id,session_id,owner_address,origin,state,contract_id,contract_address,seller_address,terms_hash,amount_tinybar,quote_expires_at,refund_after,prepared_block,scan_next_block,prepared_at,transaction_json,transaction_hash,wallet_opened_at,runtime_sha256,abi_json,updated_at)
 VALUES (?,?,?,?,?,'submitted','0.0.33',?,?,?,'100',?,?,1,1,?,?,?,?,?,?,?)`).run(fundingId,'9'.repeat(32),session.sessionId,buyer,origin.origin,contract,seller,termsHash,now-1200,now-600,now-1800,JSON.stringify(fundingTx),fundingHash,now-1790,runtimeHash,JSON.stringify(abi),now);
 const chain = { failHash: fundingHash, nonce: '0x4', pending: '0x4', state: 1, used: false, logs: [], blockTime: now, hook: null };
 function seedRefund() {
  db.prepare("UPDATE customer_funding_intents SET state='executed',contract_state='funded',escrow_id='1',confirmed_hash=? WHERE id=?").run(fundingHash,fundingId);
  db.prepare(`INSERT INTO customer_refund_intents
   (id,funding_id,session_id,owner_address,origin,state,escrow_id,contract_id,contract_address,amount_tinybar,prepared_block,scan_next_block,prepared_at,transaction_json,transaction_hash,wallet_opened_at,wallet_open_count,abi_json,updated_at)
   VALUES(?,?,?,?,?,'submitted','1','0.0.33',?,'100',1,1,?,?,?,?,1,?,?)`).run(refundId,fundingId,session.sessionId,buyer,origin.origin,contract,now-1000,JSON.stringify(refundTx),hash,now-999,JSON.stringify(abi),now);
  chain.failHash=hash;
 }
 const savedFetch = global.fetch;
 global.fetch = async (url,options={})=>{
  if(options.method==='POST') {
   const {id,method,params}=JSON.parse(options.body);
   let result;
   if(chain.hook) await chain.hook(method, params);
   if(method==='eth_getTransactionCount')result=params[1]==='pending'?chain.pending:chain.nonce;
   else if(method==='eth_chainId')result='0x128';
   else if(method==='eth_getCode')result=runtime;
   else if(method==='eth_getBlockByNumber')result={number:'0x64',timestamp:'0x'+chain.blockTime.toString(16)};
   else if(method==='eth_getLogs')result=chain.logs.filter(log=>log.topics[0]===params[0].topics[0]);
   else if(method==='eth_gasPrice')result='0x1';
   else if(method==='eth_getBalance')result='0xffffffffffffffffffff';
   else if(method==='eth_estimateGas')result='0x186a0';
   else if(method==='eth_call') {
    const decoded = iface.parseTransaction({data:params[0].data});
    const terms=chain.fundingTerms ?? {expiresAt:now-1200,refundAfter:now-600,termsHash};
    result=decoded.name==='usedTermsHash'?iface.encodeFunctionResult('usedTermsHash',[chain.used]):iface.encodeFunctionResult('escrows',[buyer,seller,100,terms.expiresAt,terms.refundAfter,terms.termsHash,chain.state]);
   } else if(method==='eth_getTransactionByHash')result={...(params[0]===fundingHash?fundingTx:refundTx),input:(params[0]===fundingHash?fundingTx:refundTx).data,hash:params[0]};
   else if(method==='eth_getTransactionReceipt') {
    result={status:params[0]===chain.failHash?'0x0':'0x1',transactionHash:params[0],logs:[]};
    if(params[0]===fundingHash&&chain.failHash!==fundingHash) {
      const terms=chain.fundingTerms ?? {expiresAt:now-1200,refundAfter:now-600,termsHash};
      const encoded=iface.encodeEventLog(iface.getEvent('Funded'),[1,buyer,seller,100,terms.expiresAt,terms.refundAfter,terms.termsHash]);
      result.logs=[{address:contract,...encoded}];
    } else if(params[0]!==chain.failHash) {
      const encoded=iface.encodeEventLog(iface.getEvent('Refunded'),[1,buyer,buyer,100]);
      result.logs=[{address:contract,...encoded}];
    }
   } else throw Error('Unmocked RPC '+method);
   return Response.json({jsonrpc:'2.0',id,result});
  }
  if(String(url).includes('/contracts/results/')) { const queriedHash=String(url).split('/').pop(); return Response.json({contract_id:'0.0.33',hash:queriedHash,result:queriedHash===chain.failHash?'CONTRACT_REVERT_EXECUTED':'SUCCESS'}); }
  if(String(url).endsWith('/contracts/0.0.33'))return Response.json({contract_id:'0.0.33',deleted:false,evm_address:contract,expiration_timestamp:String(now+86400*50)+'.000000000'});
  throw Error('Unexpected network request '+url);
 };
 Object.assign(process.env,{HEDERA_NETWORK:'testnet',HEDERA_RPC_URL:'https://testnet.hashio.io/api',NEURON_ENABLE_CUSTOMER_APPROVAL:'true',NEURON_ESCROW_RUNTIME_SHA256:runtimeHash,NEURON_COMMERCE_MAX_TX_FEE_TINYBAR:'100000000'});
 return {api,db,databasePath,chain,seedRefund,verified,fundingTx,cleanup:()=>{global.fetch=savedFetch;db.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
async function rejects409(action,pattern) {await assert.rejects(action,error=>error.status===409&&pattern.test(error.message));}

test('confirmed reverted funding safely closes after expiry, retains hash and permits fresh-session quote',async()=>{
 const f=await fixture();try{
  assert.equal((await f.api.reconcileCustomerFunding(session,origin,fundingId)).state,'failed');
  const closed=await f.api.resolveExpiredCustomerFunding(session,origin,fundingId);
  assert.equal(closed.funding.state,'abandoned'); assert.equal(closed.scanComplete,true);
  assert.equal(closed.funding.reportedHash,fundingHash);
  const reauth={...session,sessionId:'3'.repeat(32)};
  f.db.prepare('INSERT INTO customer_sessions VALUES(?,?,?,NULL,?)').run(reauth.sessionId,buyer,origin.origin,reauth.expiresAt);
  assert.equal((await f.api.prepareCustomerFunding(reauth,origin,'8'.repeat(32))).funding.state,'prepared');
 }finally{f.cleanup();}
});
test('expiry closure refuses successful, unknown hashed, used or revoked funding',async()=>{
 for(const scenario of ['unknown','used','revoked','not-expired']) {
  const f=await fixture();try{
   if(scenario!=='unknown') await f.api.reconcileCustomerFunding(session,origin,fundingId);
   if(scenario==='used') f.chain.used=true;
   if(scenario==='revoked') f.db.prepare('UPDATE customer_sessions SET revoked_at=?').run(now);
   if(scenario==='not-expired') f.chain.blockTime=now-1201;
   await assert.rejects(()=>f.api.resolveExpiredCustomerFunding(session,origin,fundingId));
   assert.equal(f.db.prepare('SELECT abandoned_at FROM customer_funding_intents').get().abandoned_at,null);
  }finally{f.cleanup();}
 }
});
test('failed refund retries, retains failed hash, and reconciles one effective refund',async()=>{
 const f=await fixture();try{
  f.seedRefund();
  assert.equal((await f.api.reconcileCustomerRefund(session,origin,refundId)).state,'failed');
  const retry=await f.api.retryCustomerRefundWallet(session,origin,refundId);
  assert.equal(retry.transaction.nonce,'0x4'); assert.equal(retry.refund.walletOpenCount,2);
  const archived=f.db.prepare('SELECT * FROM customer_wallet_attempts WHERE nonce IS NULL').get();
  assert.equal(archived.reported_hash,hash); assert.equal(archived.previous_state,'failed');
  const success='0x'+'1'.repeat(64);
  f.api.attachCustomerRefundHash(session,origin,refundId,success,retry.refund.walletAttemptId);
  f.chain.state=4;
  assert.equal((await f.api.reconcileCustomerRefund(session,origin,refundId)).state,'executed');
  await assert.rejects(()=>f.api.retryCustomerRefundWallet(session,origin,refundId));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,2);
 }finally{f.cleanup();}
});
test('legacy repeated rejection recovers and modern retries retain the same nonce across retries',async()=>{
 const f=await fixture();try{
  f.seedRefund();
  f.db.prepare("UPDATE customer_refund_intents SET state='prepared',transaction_hash=NULL,wallet_open_count=2").run();
  const first=await f.api.retryCustomerRefundWallet(session,origin,refundId);
  assert.equal(first.refund.walletOpenCount,3);
  assert.equal(f.db.prepare('SELECT legacy_open_count FROM customer_wallet_attempts WHERE nonce IS NULL').get().legacy_open_count,2);
  f.db.prepare('UPDATE customer_refund_intents SET wallet_opened_at=?').run(now-61);
  const second=await f.api.retryCustomerRefundWallet(session,origin,refundId);
  assert.equal(second.transaction.nonce,first.transaction.nonce);
  assert.notEqual(second.refund.walletAttemptId,first.refund.walletAttemptId);
  // A delayed old wallet reply is saved against its opening, not attached to the new generation.
  const oldHash='0x'+'2'.repeat(64);
  assert.equal(f.api.attachCustomerRefundHash(session,origin,refundId,oldHash,first.refund.walletAttemptId).reportedHash,null);
  assert.equal(f.db.prepare('SELECT reported_hash FROM customer_wallet_attempts WHERE id=?').get(first.refund.walletAttemptId).reported_hash,oldHash);
  assert.throws(()=>f.api.attachCustomerRefundHash(session,origin,refundId,hash),/opening reference/);
 }finally{f.cleanup();}
});
test('concurrent retry and revoked-session preflight commit have one or no winners',async()=>{
 const f=await fixture();try{
  f.seedRefund();f.db.prepare("UPDATE customer_refund_intents SET state='prepared',transaction_hash=NULL").run();
  const outcomes=await Promise.allSettled([f.api.retryCustomerRefundWallet(session,origin,refundId),f.api.retryCustomerRefundWallet(session,origin,refundId)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  f.db.prepare('UPDATE customer_refund_intents SET wallet_opened_at=?').run(now-61);
  f.chain.hook=async method=>{if(method==='eth_getTransactionCount')f.db.prepare('UPDATE customer_sessions SET revoked_at=?').run(now);};
  await assert.rejects(()=>f.api.retryCustomerRefundWallet(session,origin,refundId),/journal changed/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,2);
 }finally{f.cleanup();}
});
test('delayed earlier success prevents retry and is discovered without its returned hash',async()=>{
 const f=await fixture();try{
  f.seedRefund();f.db.prepare("UPDATE customer_refund_intents SET state='prepared',transaction_hash=NULL").run();
  const success='0x'+'3'.repeat(64);
  f.chain.logs=[{address:contract,transactionHash:success,...iface.encodeEventLog(iface.getEvent('Refunded'),[1,buyer,buyer,100])}];
  f.chain.state=4;
  await assert.rejects(()=>f.api.retryCustomerRefundWallet(session,origin,refundId));
  assert.equal(f.api.customerRefundForFunding(session,origin,fundingId).state,'executed');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,0);
 }finally{f.cleanup();}
});
test('external nonce cancellation recovers only with pinned nonterminal storage; pending transactions block',async()=>{
 const f=await fixture();try{
  f.seedRefund(); f.db.prepare("UPDATE customer_refund_intents SET state='prepared',transaction_hash=NULL").run();
  f.chain.pending='0x5';
  await assert.rejects(()=>f.api.retryCustomerRefundWallet(session,origin,refundId),/Another wallet transaction/);
  f.chain.pending='0x4';
  await f.api.retryCustomerRefundWallet(session,origin,refundId);
  f.db.prepare('UPDATE customer_refund_intents SET wallet_opened_at=?').run(now-61);
  f.chain.nonce=f.chain.pending='0x5';
  const recovered=await f.api.retryCustomerRefundWallet(session,origin,refundId);
  assert.equal(recovered.transaction.nonce,'0x5');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,3);
 }finally{f.cleanup();}
});
test('wallet nonce reservation prevents cross-operation collision and survives opening persistence',async()=>{
 const f=await fixture();try{
  const helper=load('customer-wallet-attempts',{'./customer-commerce':{CommerceIssue}});
  const row={id:fundingId,owner_address:buyer,origin:origin.origin,transaction_json:'{}',transaction_hash:null,state:'prepared'};
  f.db.transaction(()=>helper.recordWalletAttempt(f.db,'funding',row,{nonce:'0x4'},now,null)).immediate();
  assert.throws(()=>f.db.transaction(()=>helper.recordWalletAttempt(f.db,'approval',{...row,id:refundId},{nonce:'0x4'},now,null)).immediate(),/another durable intent/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,1);
 }finally{f.cleanup();}
});

async function approvalFixture() {
 const f=await fixture();
 const { Wallet, keccak256 }=require('ethers');
 const wallet=Wallet.createRandom();
 const payee=wallet.address;
 const key=wallet.signingKey.compressedPublicKey.slice(2);
 const terms={serviceId:'1',sellerAccountId:'0.0.22',sessionId:session.sessionId,buyerAddress:buyer,
  asset:'HBAR',escrowContractId:'0.0.33',escrowAddress:contract,sellerAddress:payee,amountTinybar:'100',durationSeconds:'120'};
 const text=JSON.stringify(terms), payload=Buffer.from(text), termsDigest=keccak256(payload);
 f.db.exec(`CREATE TABLE customer_commerce_intents(id TEXT, seller_account TEXT, session_id TEXT,
  terms_json TEXT,quote_topic TEXT,quote_sequence INTEGER,terms_hash TEXT);
  CREATE TABLE customer_service_requests(session_id TEXT,owner_address TEXT,origin TEXT,state TEXT,
  seller_account TEXT,transaction_id TEXT,payload_sha256 TEXT,topic_sequence INTEGER);`);
 f.db.prepare('INSERT INTO customer_commerce_intents VALUES(?,?,?,?,?,?,?)')
  .run('9'.repeat(32),'0.0.22',session.sessionId,text,'0.0.44',1,termsDigest);
 f.db.prepare("UPDATE customer_funding_intents SET state='executed',contract_state='funded',escrow_id='1',confirmed_hash=?,seller_address=?,terms_hash=?,refund_after=?")
  .run(fundingHash,payee,termsDigest,now+1200);
 const requestBytes=Buffer.from('actual request fixture');
 const timestamp=`${now-200}.000000001`;
 const requestId=`0.0.55-${now-201}-000000001`;
 f.db.prepare('INSERT INTO customer_service_requests VALUES(?,?,?,?,?,?,?,?)')
  .run(session.sessionId,buyer,origin.origin,'confirmed','0.0.22',`0.0.55@${now-201}.000000001`,createHash('sha256').update(requestBytes).digest('hex'),2);
 const privateDir=fs.mkdtempSync(require('node:os').tmpdir()+'/native-approval-');fs.chmodSync(privateDir,0o700);
 const token=path.join(privateDir,'token');fs.writeFileSync(token,'a'.repeat(64),{mode:0o600});
 Object.assign(process.env,{NEURON_ENABLE_CUSTOMER_AUTH:'true',NEURON_ENABLE_CUSTOMER_FUNDING:'true',
  NEURON_GATEWAY_INTERNAL_ORIGIN:'http://127.0.0.1:3499',NEURON_GATEWAY_WS_URL:'ws://127.0.0.1:3499/stream',
  NEURON_ENABLE_LOCAL_STREAM:'true',NEURON_SELLER_ACCOUNT_ID:'0.0.22',NEURON_COMMERCE_SELLER_ACCOUNT_ID:'0.0.22',
  NEURON_COMMERCE_SERVICE_ID:'1',NEURON_SESSION_TOKEN_FILE:token,NEURON_SELLER_STDIN_TOPIC_ID:'0.0.45',HEDERA_OPERATOR_ACCOUNT_ID:'0.0.55'});
 const hedera=await import(path.join(root,'packages/neuron-hedera/dist/index.js'));
 const opening=new Date((now-150)*1000).toISOString(), closing=new Date((now-10)*1000).toISOString();
 const control={bytes:512,sellerKey:key,state:1,fail:false,nonce:'0x4',pending:'0x4',hook:null,logs:[]};
 const api=load('customer-approval',{
  './customer-auth':{withCustomerDatabase:work=>work(f.db)},
  './customer-commerce':{CommerceIssue},
  './commerce-guards':load('commerce-guards',{'./customer-auth':{customerAccessAllowed:()=>true}}),
  './customer-wallet-attempts':load('customer-wallet-attempts',{'./customer-commerce':{CommerceIssue}}),
  './customer-funding':{customerFundingPinnedInterface:()=>iface,reconcileCustomerFunding:async()=>({state:'executed',contractState:control.state===1?'funded':'approved',escrowId:'1'})},
  './customer-approval-evidence':load('customer-approval-evidence',{}),
  './gateway-endpoint':load('gateway-endpoint',{}),
  '@neuron/hedera':{...hedera,
   getTopicMessageBySequence:async(_network,topic,sequence)=>({topicId:topic,sequenceNumber:sequence,
    payerAccountId:topic==='0.0.44'?'0.0.22':'0.0.55',bytes:topic==='0.0.44'?payload:requestBytes,consensusTimestamp:timestamp}),
   getMirrorAccount:async()=>({key:{_type:'ECDSA_SECP256K1',key:control.sellerKey},evm_address:payee}),
   inspectSignedTopicEnvelope:()=>({compressedPublicKey:key,payload,senderAddress:payee})},
 });
 global.fetch=async(url,options={})=>{
  if(String(url).includes('/transport-evidence')) return Response.json({network:'testnet',sellerAccount:'0.0.22',sellerPublicKey:key,
   ownerAddress:buyer.toLowerCase(),customerSessionId:session.sessionId,transportEvidenceOnly:true,
   closedConnections:1,interruptedConnections:0,openConnections:0,totalWrittenBytes:control.bytes,truncated:false,
   connections:[{openedAt:opening,closedAt:closing,writtenBytes:control.bytes}]});
  if(options.method==='POST') {
   const {id,method,params}=JSON.parse(options.body);let result;
   if(control.hook) await control.hook(method,params);
   if(method==='eth_chainId')result='0x128';
   else if(method==='eth_getTransactionCount')result=params[1]==='pending'?control.pending:control.nonce;
   else if(method==='eth_getCode')result=runtime;
   else if(method==='eth_getBlockByNumber')result={number:'0x64',timestamp:'0x'+(params[0]==='latest'?now:now-300).toString(16)};
   else if(method==='eth_call')result=iface.encodeFunctionResult('escrows',[buyer,payee,100,now-1200,now+1200,termsDigest,control.state]);
   else if(method==='eth_getLogs')result=control.logs;
   else if(method==='eth_gasPrice')result='0x1';
   else if(method==='eth_getBalance')result='0xffffffffffffffff';
   else if(method==='eth_estimateGas')result='0x186a0';
   else if(method==='eth_getTransactionByHash')result={hash:params[0],from:buyer,to:contract,input:iface.encodeFunctionData('approve',[1]),value:'0x0'};
   else if(method==='eth_getTransactionReceipt')result={transactionHash:params[0],status:control.fail&&params[0]!==fundingHash?'0x0':'0x1',blockNumber:'0x1',logs:params[0]===fundingHash?[]:[{address:contract,...iface.encodeEventLog(iface.getEvent('Approved'),[1,buyer])}]};
   else throw Error('Unmocked approval RPC '+method);
   return Response.json({jsonrpc:'2.0',id,result});
  }
  if(String(url).includes('/contracts/results/'))return Response.json({contract_id:'0.0.33',hash:String(url).split('/').pop(),result:control.fail?'CONTRACT_REVERT_EXECUTED':'SUCCESS'});
  if(String(url).endsWith('/contracts/0.0.33'))return Response.json({contract_id:'0.0.33',deleted:false,evm_address:contract,expiration_timestamp:`${now+86400*50}.000000000`});
  if(String(url).includes('/transactions/'))return Response.json({transactions:[{transaction_id:requestId,name:'CONSENSUSSUBMITMESSAGE',result:'SUCCESS',entity_id:'0.0.45',consensus_timestamp:timestamp}]});
  throw Error('Unexpected approval network '+url);
 };
 return {...f,approval:api,control,cleanup:()=>{fs.rmSync(privateDir,{recursive:true,force:true});f.cleanup();}};
}

test('approval rejected twice retries same nonce with original delivery checks and executes once',async()=>{
 const f=await approvalFixture();try{
  const prepared=await f.approval.prepareCustomerApproval(session,origin,fundingId);
  const first=await f.approval.markCustomerApprovalWalletOpened(session,origin,prepared.approval.id,true);
  assert.equal(first.transaction.nonce,'0x4');
  for(let i=0;i<2;i++) {
   f.db.prepare('UPDATE customer_approval_intents SET buyer_acknowledged_at=?').run(now-61);
   const retry=await f.approval.markCustomerApprovalWalletOpened(session,origin,first.approval.id,true,true);
   assert.equal(retry.transaction.nonce,'0x4');
  }
  const current=f.approval.approvalForFunding(session,origin,fundingId);
  const success='0x'+'6'.repeat(64);
  f.approval.attachCustomerApprovalHash(session,origin,current.id,success,current.walletAttemptId);
  f.control.state=2;
  assert.equal((await f.approval.reconcileCustomerApproval(session,origin,current.id)).state,'executed');
  await assert.rejects(()=>f.approval.markCustomerApprovalWalletOpened(session,origin,current.id,true,true));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,3);
 }finally{f.cleanup();}
});
test('approval recovery rechecks acknowledgement, seller key, request, transport, ownership and session',async()=>{
 for(const scenario of ['acknowledgement','seller-key','request','transport','owner','origin','revoked']) {
  const f=await approvalFixture();try{
   const prepared=await f.approval.prepareCustomerApproval(session,origin,fundingId);
   const first=await f.approval.markCustomerApprovalWalletOpened(session,origin,prepared.approval.id,true);
   f.db.prepare('UPDATE customer_approval_intents SET buyer_acknowledged_at=?').run(now-61);
   if(scenario==='seller-key')f.control.sellerKey='02'+'1'.repeat(64);
   if(scenario==='request')f.db.prepare("UPDATE customer_service_requests SET state='uncertain'").run();
   if(scenario==='transport')f.control.bytes=0;
   if(scenario==='revoked')f.control.hook=async method=>{if(method==='eth_getTransactionCount')f.db.prepare('UPDATE customer_sessions SET revoked_at=?').run(now);};
   await assert.rejects(()=>f.approval.markCustomerApprovalWalletOpened(scenario==='owner'?{...session,ownerAddress:seller}:session,
    scenario==='origin'?new URL('http://other.example'):origin,first.approval.id,scenario!=='acknowledgement',true));
   assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,1);
  }finally{f.cleanup();}
 }
});
test('failed approval uses new final nonce and concurrent retries have one winner',async()=>{
 const f=await approvalFixture();try{
  const prepared=await f.approval.prepareCustomerApproval(session,origin,fundingId);
  const first=await f.approval.markCustomerApprovalWalletOpened(session,origin,prepared.approval.id,true);
  f.approval.attachCustomerApprovalHash(session,origin,first.approval.id,hash,first.approval.walletAttemptId);
  f.control.fail=true;f.control.nonce=f.control.pending='0x5';
  const outcomes=await Promise.allSettled([f.approval.markCustomerApprovalWalletOpened(session,origin,first.approval.id,true,true),f.approval.markCustomerApprovalWalletOpened(session,origin,first.approval.id,true,true)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.find(x=>x.status==='fulfilled').value.transaction.nonce,'0x5');
  assert.equal(f.db.prepare('SELECT reported_hash FROM customer_wallet_attempts WHERE id=?').get(first.approval.walletAttemptId).reported_hash,hash);
 }finally{f.cleanup();}
});

test('wallet opening and legacy migration survive an independent process reading durable SQLite',async()=>{
 const f=await fixture();try{
  f.seedRefund(); f.db.prepare("UPDATE customer_refund_intents SET state='prepared',transaction_hash=NULL,wallet_open_count=2").run();
  f.db.exec('ALTER TABLE customer_refund_intents DROP COLUMN wallet_attempt_id');
  const opened=await f.api.retryCustomerRefundWallet(session,origin,refundId);
  const output=require('node:child_process').execFileSync(process.execPath,['-e',
   `const D=require('better-sqlite3');const db=new D(process.argv[1]);process.stdout.write(JSON.stringify({row:db.prepare('SELECT * FROM customer_refund_intents').get(),attempts:db.prepare('SELECT * FROM customer_wallet_attempts').all()}));db.close()`,f.databasePath],{cwd:root,encoding:'utf8'});
  const durable=JSON.parse(output);
  assert.equal(durable.row.wallet_attempt_id,opened.refund.walletAttemptId);
  assert.equal(JSON.parse(durable.row.transaction_json).nonce,'0x4');
  assert.equal(durable.attempts.length,2);
  assert.equal(durable.attempts.find(x=>x.nonce===null).legacy_open_count,2);
 }finally{f.cleanup();}
});
test('late failure reconciliation cannot overwrite a newer retry generation',async()=>{
 const f=await fixture();try{
  f.seedRefund();
  let release; const waiting=new Promise(resolve=>{release=resolve;});
  let reached; const entered=new Promise(resolve=>{reached=resolve;}); let first=true;
  f.chain.hook=async(method,params)=>{if(method==='eth_getTransactionReceipt'&&params[0]===hash&&first){first=false;reached();await waiting;}};
  const stale=f.api.reconcileCustomerRefund(session,origin,refundId);await entered;
  const fresh=await f.api.retryCustomerRefundWallet(session,origin,refundId);
  release();await stale;
  const current=f.api.customerRefundForFunding(session,origin,fundingId);
  assert.equal(current.state,'prepared'); assert.equal(current.walletAttemptId,fresh.refund.walletAttemptId);
  assert.equal(current.reportedHash,null);
 }finally{f.cleanup();}
});
test('same buyer reauthentication recovers legacy refund; another owner and origin cannot',async()=>{
 const f=await fixture();try{
  f.seedRefund();f.db.prepare("UPDATE customer_refund_intents SET state='prepared',transaction_hash=NULL").run();
  const reauth={...session,sessionId:'4'.repeat(32)};
  f.db.prepare('INSERT INTO customer_sessions VALUES(?,?,?,NULL,?)').run(reauth.sessionId,buyer,origin.origin,reauth.expiresAt);
  f.db.prepare('UPDATE customer_sessions SET revoked_at=? WHERE session_id=?').run(now,session.sessionId);
  await assert.rejects(()=>f.api.retryCustomerRefundWallet({...reauth,ownerAddress:seller},origin,refundId));
  await assert.rejects(()=>f.api.retryCustomerRefundWallet(reauth,new URL('http://wrong.example'),refundId));
  assert.equal((await f.api.retryCustomerRefundWallet(reauth,origin,refundId)).refund.walletOpenCount,2);
 }finally{f.cleanup();}
});

test('same-nonce duplicate wallet hash returns are idempotent within one intent only',async()=>{
 const f=await fixture();try{
  f.seedRefund();f.db.prepare("UPDATE customer_refund_intents SET state='prepared',transaction_hash=NULL").run();
  const first=await f.api.retryCustomerRefundWallet(session,origin,refundId);
  f.api.attachCustomerRefundHash(session,origin,refundId,hash,first.refund.walletAttemptId);
  // RPC receipt is not indexed yet: a same-nonce retry remains the same logical transaction.
  const oldFetch=global.fetch;
  global.fetch=async(url,options={})=>{if(options.method==='POST'&&JSON.parse(options.body).method==='eth_getTransactionReceipt'&&JSON.parse(options.body).params[0]===hash)return Response.json({jsonrpc:'2.0',id:1,result:null});return oldFetch(url,options);};
  f.db.prepare('UPDATE customer_refund_intents SET wallet_opened_at=?').run(now-61);
  const second=await f.api.retryCustomerRefundWallet(session,origin,refundId);
  assert.equal(f.api.attachCustomerRefundHash(session,origin,refundId,hash,second.refund.walletAttemptId).reportedHash,hash);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts WHERE reported_hash=?').get(hash).n,2);
  const helper=load('customer-wallet-attempts',{'./customer-commerce':{CommerceIssue}});
  const row={id:'5'.repeat(32),owner_address:buyer,origin:origin.origin,transaction_json:'{}',transaction_hash:null,state:'prepared'};
  const otherId=f.db.transaction(()=>helper.recordWalletAttempt(f.db,'approval',row,{nonce:'0x5'},now,null)).immediate();
  assert.throws(()=>f.db.transaction(()=>helper.attachWalletAttempt(f.db,'approval',{...row,wallet_attempt_id:otherId},hash,otherId)).immediate(),/another intent/);
 }finally{f.cleanup();}
});

test('consumed refund nonce refuses changed pinned runtime, terminal escrow and inconsistent RPC counts',async()=>{
 for(const scenario of ['runtime','terminal','nonce-count']) {
  const f=await fixture();try{
   f.seedRefund();f.db.prepare("UPDATE customer_refund_intents SET state='prepared',transaction_hash=NULL").run();
   await f.api.retryCustomerRefundWallet(session,origin,refundId);
   f.db.prepare('UPDATE customer_refund_intents SET wallet_opened_at=?').run(now-61);
   f.chain.nonce=f.chain.pending='0x5';
   if(scenario==='nonce-count')f.chain.pending='0x4';
   if(scenario==='terminal')f.chain.hook=async method=>{if(method==='eth_getTransactionCount')f.chain.state=4;};
   const originalFetch=global.fetch;
   if(scenario==='runtime')global.fetch=async(url,options={})=>{
    if(options.method==='POST') {const request=JSON.parse(options.body);if(request.method==='eth_getCode'&&request.params[1]!=='latest')return Response.json({jsonrpc:'2.0',id:1,result:'0x6001'});}
    return originalFetch(url,options);
   };
   await assert.rejects(()=>f.api.retryCustomerRefundWallet(session,origin,refundId),scenario==='nonce-count'?/nonce observations disagree/:/cannot prove the same refundable escrow/);
   assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,2);
   assert.equal(JSON.parse(f.db.prepare('SELECT transaction_json FROM customer_refund_intents').get().transaction_json).nonce,'0x4');
  }finally{f.cleanup();}
 }
});
test('approval consumed-nonce proof recovers cancellation and refuses already approved pinned storage',async()=>{
 for(const terminal of [false,true]) {
  const f=await approvalFixture();try{
   const prepared=await f.approval.prepareCustomerApproval(session,origin,fundingId);
   const first=await f.approval.markCustomerApprovalWalletOpened(session,origin,prepared.approval.id,true);
   f.db.prepare('UPDATE customer_approval_intents SET buyer_acknowledged_at=?').run(now-61);
   f.control.nonce=f.control.pending='0x5';
   if(terminal)f.control.hook=async method=>{if(method==='eth_getTransactionCount')f.control.state=2;};
   if(terminal) {
    await assert.rejects(()=>f.approval.markCustomerApprovalWalletOpened(session,origin,first.approval.id,true,true),/no longer the original funded/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,1);
   }else {
    assert.equal((await f.approval.markCustomerApprovalWalletOpened(session,origin,first.approval.id,true,true)).transaction.nonce,'0x5');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,2);
   }
  }finally{f.cleanup();}
 }
});

function rejectedFunding(f) {
 const {terms}=f.verified;
 const transaction={from:buyer,to:contract,value:'0xe8d4a51000',
  data:iface.encodeFunctionData('fund',[seller,terms.expiresAt,terms.refundAfter,f.verified.termsHash]),
  gas:'0x1fbd0',gasPrice:'0x1',chainId:'0x128',nonce:'0x4'};
 Object.assign(f.fundingTx,transaction);
 f.chain.fundingTerms={expiresAt:Number(terms.expiresAt),refundAfter:Number(terms.refundAfter),termsHash:f.verified.termsHash};
 f.db.prepare(`UPDATE customer_funding_intents SET state='prepared',transaction_hash=NULL,
  observed_hash=NULL,confirmed_hash=NULL,wallet_opened_at=?,terms_hash=?,quote_expires_at=?,refund_after=?,
  transaction_json=? WHERE id=?`).run(now-61,f.verified.termsHash,terms.expiresAt,terms.refundAfter,JSON.stringify(transaction),fundingId);
 const helper=load('customer-wallet-attempts',{'./customer-commerce':{CommerceIssue}});
 const row=f.db.prepare('SELECT * FROM customer_funding_intents WHERE id=?').get(fundingId);
 const attemptId=f.db.transaction(()=>helper.recordWalletAttempt(f.db,'funding',row,transaction,now-61,null)).immediate();
 f.db.prepare('UPDATE customer_funding_intents SET wallet_attempt_id=? WHERE id=?').run(attemptId,fundingId);
 return {transaction,attemptId};
}

test('funding cancellation retry preserves the original nonce and call with a new durable opening',async()=>{
 const f=await fixture();try{
  const original=rejectedFunding(f);
  const retry=await f.api.retryCustomerFundingWallet(session,origin,fundingId,true);
  assert.equal(retry.funding.id,fundingId);
  assert.notEqual(retry.funding.walletAttemptId,original.attemptId);
  for(const key of ['from','to','value','data','chainId','nonce'])assert.equal(retry.transaction[key],original.transaction[key]);
  const attempts=f.db.prepare('SELECT * FROM customer_wallet_attempts ORDER BY opened_at').all();
  assert.equal(attempts.length,2);assert.equal(attempts[0].id,original.attemptId);
  assert.equal(attempts[0].nonce,attempts[1].nonce);
  await rejects409(()=>f.api.retryCustomerFundingWallet(session,origin,fundingId,true),/reconcile/);
 }finally{f.cleanup();}
});

test('funding retry requires acknowledgement, exact original session and current quote timing',async()=>{
 for(const scenario of ['consent','owner','origin','session','revoked','too-soon','short-quote','terms','legacy-nonce']) {
  const f=await fixture();try{
   rejectedFunding(f);let caller=session, callerOrigin=origin;
   if(scenario==='owner')caller={...session,ownerAddress:seller};
   if(scenario==='origin')callerOrigin=new URL('http://localhost:4000');
   if(scenario==='session')caller={...session,sessionId:'2'.repeat(32)};
   if(scenario==='revoked')f.db.prepare('UPDATE customer_sessions SET revoked_at=?').run(now);
   if(scenario==='too-soon')f.db.prepare('UPDATE customer_funding_intents SET wallet_opened_at=?').run(now);
   if(scenario==='short-quote')f.db.prepare('UPDATE customer_funding_intents SET quote_expires_at=?').run(now+120);
   if(scenario==='terms')f.verified.terms.amountTinybar='101';
   if(scenario==='legacy-nonce')f.db.prepare("UPDATE customer_funding_intents SET transaction_json=json_remove(transaction_json,'$.nonce')").run();
   await assert.rejects(()=>f.api.retryCustomerFundingWallet(caller,callerOrigin,fundingId,scenario!=='consent'));
   assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,1,scenario);
  }finally{f.cleanup();}
 }
});

test('funding retry refuses pending, consumed or inconsistent nonces without advancing to another nonce',async()=>{
 for(const [latest,pending] of [['0x4','0x5'],['0x5','0x5'],['0x3','0x3'],['0x5','0x4']]) {
  const f=await fixture();try{
   rejectedFunding(f);f.chain.nonce=latest;f.chain.pending=pending;
   await assert.rejects(()=>f.api.retryCustomerFundingWallet(session,origin,fundingId,true),/pending|consumed|settle|disagree/);
   assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,1);
  }finally{f.cleanup();}
 }
});

test('funding retry reconciles a lost accepted response and refuses another wallet opening',async()=>{
 const f=await fixture();try{
  rejectedFunding(f);f.chain.failHash=null;f.chain.used=true;f.chain.nonce=f.chain.pending='0x5';
  const t=f.chain.fundingTerms;
  f.chain.logs=[{address:contract,transactionHash:fundingHash,...iface.encodeEventLog(iface.getEvent('Funded'),
   [1,buyer,seller,100,t.expiresAt,t.refundAfter,t.termsHash])}];
  await assert.rejects(()=>f.api.retryCustomerFundingWallet(session,origin,fundingId,true),/reconcile/);
  const row=f.api.customerFundingById(session,origin,fundingId);
  assert.equal(row.state,'executed');assert.equal(row.observedHash,fundingHash);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,1);
 }finally{f.cleanup();}
});

test('funding retry rejects used terms even while the funding event is delayed',async()=>{
 const f=await fixture();try{
  rejectedFunding(f);f.chain.used=true;
  await assert.rejects(()=>f.api.retryCustomerFundingWallet(session,origin,fundingId,true),/already funded/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,1);
 }finally{f.cleanup();}
});

test('funding retry has one concurrent winner and refuses session revocation during preflight',async()=>{
 const f=await fixture();try{
  rejectedFunding(f);
  const result=await Promise.allSettled([f.api.retryCustomerFundingWallet(session,origin,fundingId,true),
   f.api.retryCustomerFundingWallet(session,origin,fundingId,true)]);
  assert.equal(result.filter(outcome=>outcome.status==='fulfilled').length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,2);
  f.db.prepare('UPDATE customer_funding_intents SET wallet_opened_at=?').run(now-61);
  f.chain.hook=async method=>{if(method==='eth_getTransactionCount')f.db.prepare('UPDATE customer_sessions SET revoked_at=?').run(now);};
  await assert.rejects(()=>f.api.retryCustomerFundingWallet(session,origin,fundingId,true),/expired|attempted/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,2);
 }finally{f.cleanup();}
});

test('late funding hash stays on its original opening and blocks retry until reconciled',async()=>{
 const f=await fixture();try{
  const original=rejectedFunding(f);
  const retry=await f.api.retryCustomerFundingWallet(session,origin,fundingId,true);
  const attached=f.api.attachCustomerFundingHash(session,origin,fundingId,fundingHash,original.attemptId);
  assert.equal(attached.reportedHash,null);assert.equal(attached.walletAttemptId,retry.funding.walletAttemptId);
  assert.equal(f.db.prepare('SELECT reported_hash FROM customer_wallet_attempts WHERE id=?').get(original.attemptId).reported_hash,fundingHash);
  f.db.prepare('UPDATE customer_funding_intents SET wallet_opened_at=?').run(now-61);
  await assert.rejects(()=>f.api.retryCustomerFundingWallet(session,origin,fundingId,true),/Earlier funding attempts/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,2);
 }finally{f.cleanup();}
});

test('a prior funding callback during retry preflight prevents the new opening from committing',async()=>{
 const f=await fixture();try{
  const original=rejectedFunding(f);
  f.chain.hook=async method=>{if(method==='eth_getTransactionCount')f.db.prepare('UPDATE customer_wallet_attempts SET reported_hash=? WHERE id=?').run(fundingHash,original.attemptId);};
  await assert.rejects(()=>f.api.retryCustomerFundingWallet(session,origin,fundingId,true),/already attempted/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_wallet_attempts').get().n,1);
 }finally{f.cleanup();}
});
