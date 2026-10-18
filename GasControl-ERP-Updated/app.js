/* GasControl ERP — Firebase Auth + Firestore. All writes require Firestore Security Rules. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const money = n => new Intl.NumberFormat('ru-KZ',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n||0))+' ₸';
  const number = n => new Intl.NumberFormat('ru-KZ',{maximumFractionDigits:3}).format(Number(n||0));
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dateText = d => { const x=d?.toDate ? d.toDate() : (d ? new Date(d) : null); return x && !isNaN(x) ? x.toLocaleString('ru-KZ') : '—'; };
  const roles = {admin:'Администратор',operator:'Оператор',dealer:'Дилер',accountant:'Бухгалтер',viewer:'Просмотр',client:'Клиент — ожидает роль'};
  const allowed = {
    dashboard:['admin','operator','accountant','viewer'],
    dealers:['admin','operator'],
    subscribers:['admin','operator'],
    readings:['admin','operator','dealer'],
    transactions:['admin','operator','dealer','accountant'],
    users:['admin'],
    settings:['admin']
  };
  let auth, db, currentUser=null, profile=null, data={dealers:[],srps:[],subscribers:[],transactions:[],users:[],settings:{tariff:35}}, importRows=[], importIssues=[];
  const pageState={subscribers:1,transactions:1,pageSize:25};
  const collectionNames={dealers:'dealers',srps:'srps',subscribers:'subscribers',transactions:'transactions',users:'users'};
  function showMessage(msg,type='info'){const el=$('global-message');el.className='notice '+(type==='error'?'warning':'info');el.textContent=msg;el.classList.remove('hidden');setTimeout(()=>el.classList.add('hidden'),6500)}
  function setLoginError(msg){$('login-error').textContent=msg||''}
  function firebaseReady(){
    const c=window.GASCONTROL_FIREBASE_CONFIG;
    return c && c.apiKey && !String(c.apiKey).includes('PASTE_') && c.projectId && !String(c.projectId).includes('YOUR_');
  }
  function setBusy(form,busy){const b=form.querySelector('button[type="submit"]');if(b){b.disabled=busy;b.dataset.original ||= b.textContent;b.textContent=busy?'Сохранение…':b.dataset.original}}
  async function writeAudit(action,details={}) {
    await db.collection('auditLogs').add({action,details,actorUid:currentUser.uid,actorEmail:currentUser.email||'',actorName:profile?.displayName||currentUser.displayName||'',createdAt:firebase.firestore.FieldValue.serverTimestamp()});
  }
  async function loadCollection(name,orderField='createdAt'){
    try { const snap=await db.collection(name).orderBy(orderField,'desc').limit(1000).get(); return snap.docs.map(d=>({id:d.id,...d.data()})); }
    catch(e){ if(e.code==='failed-precondition') { const snap=await db.collection(name).limit(1000).get();return snap.docs.map(d=>({id:d.id,...d.data()})); } throw e; }
  }
  async function refreshData(){
    const jobs=await Promise.all([
      loadCollection('dealers'),loadCollection('srps'),loadCollection('subscribers'),loadCollection('transactions'),
      profile.role==='admin'?loadCollection('users'):Promise.resolve([]),
      db.collection('settings').doc('main').get()
    ]);
    [data.dealers,data.srps,data.subscribers,data.transactions,data.users]=jobs.slice(0,5);
    if(jobs[5].exists)data.settings={...data.settings,...jobs[5].data()};
    renderAll();
  }
  function options(el,items,placeholder,labelFn){
    const old=el.value; el.innerHTML=`<option value="">${escapeHtml(placeholder)}</option>`+items.map(x=>`<option value="${escapeHtml(x.id)}">${escapeHtml(labelFn(x))}</option>`).join('');
    if(items.some(x=>x.id===old))el.value=old;
  }
  function renderAll(){
    $('stat-dealers').textContent=data.dealers.length;$('stat-srps').textContent=data.srps.length;$('stat-subscribers').textContent=data.subscribers.length;
    $('stat-billed').textContent=money(data.transactions.filter(t=>t.type==='subscriber_reading').reduce((s,t)=>s+Number(t.totalSum||0),0));
    $('current-tariff').textContent=money(data.settings.tariff)+' / м³';$('setting-tariff').value=data.settings.tariff;
    options($('srp-dealer'),data.dealers,'Выберите дилера',d=>d.name+' · '+number(d.balanceM3)+' м³');
    options($('sub-srp'),data.srps,'Выберите ШРП',s=>s.name);
    options($('import-srp-default'),data.srps,'Не использовать',s=>s.name);
    renderDealers();renderSubscribers();renderTransactions();renderUsers();renderDashboardTransactions();refreshReadingTargets();
  }
  function table(headers,rows,empty='Нет данных'){
    if(!rows.length)return `<div class="empty-state">${escapeHtml(empty)}</div>`;
    return `<table class="data-table"><thead><tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }
  function renderDealers(){
    $('dealers-table').innerHTML=table(['Дилер','Баланс, м³','Комиссия','ШРП'],data.dealers.map(d=>{
      const srps=data.srps.filter(s=>s.dealerId===d.id);
      return `<tr><td><strong>${escapeHtml(d.name)}</strong></td><td>${number(d.balanceM3)}</td><td>${money(d.defaultFee)}</td><td>${srps.map(s=>escapeHtml(s.name)).join(', ')||'—'}</td></tr>`;
    }));
  }
  function renderSubscribers(){
    const q=($('subscriber-search').value||'').trim().toLowerCase();
    const list=data.subscribers.filter(s=>[s.accountNumber,s.name,s.address,s.phone,s.meterNumber,s.iin,s.invoiceNumber].some(v=>String(v||'').toLowerCase().includes(q)));
    const pages=Math.max(1,Math.ceil(list.length/pageState.pageSize));pageState.subscribers=Math.min(pageState.subscribers,pages);const start=(pageState.subscribers-1)*pageState.pageSize;const visible=list.slice(start,start+pageState.pageSize);
    $('subscriber-count').textContent=`Показано ${list.length?start+1:0}–${Math.min(start+pageState.pageSize,list.length)} из ${list.length} · страница ${pageState.subscribers}/${pages}`;
    $('subscribers-table').innerHTML=table(['Лицевой счёт','Абонент','Адрес','Счётчик','ШРП','ИИН','Показание','Статус'],visible.map(s=>{
      const srp=data.srps.find(x=>x.id===s.srpId);
      return `<tr><td><strong>${escapeHtml(s.accountNumber)}</strong></td><td>${escapeHtml(s.name)}<br><span class="muted">${escapeHtml(s.phone||'')}</span></td><td>${escapeHtml(s.address)}</td><td>${escapeHtml(s.meterNumber)}</td><td>${escapeHtml(srp?.name||'—')}</td><td>${escapeHtml(s.iin||'—')}</td><td>${number(s.currentReading)} м³</td><td><span class="badge ${s.active===false?'off':''}">${s.active===false?'Отключён':'Активен'}</span></td></tr>`;
    }), 'Абоненты пока не добавлены');
    const pager=$('subscriber-pagination');if(pager)pager.innerHTML=`<button class="btn secondary" ${pageState.subscribers<=1?'disabled':''} data-page="prev">Назад</button><span>Страница ${pageState.subscribers} из ${pages}</span><button class="btn secondary" ${pageState.subscribers>=pages?'disabled':''} data-page="next">Далее</button>`;
  }
  function transactionRows(list){return list.map(t=>`<tr><td>${escapeHtml(dateText(t.createdAt))}</td><td><strong>${escapeHtml(t.targetName||'—')}</strong><br><span class="muted">${escapeHtml(t.iin||t.accountNumber||t.invoiceNumber||'')}</span></td><td>${escapeHtml(t.typeLabel||t.type||'—')}</td><td>${number(t.volume||0)} м³</td><td>${t.totalSum==null?'—':money(t.totalSum)}</td><td>${escapeHtml(t.paymentMethodLabel||'—')}</td><td>${escapeHtml(t.actorName||t.actorEmail||'—')}<br><span class="muted">${escapeHtml(t.actorEmail||'')}</span></td></tr>`)}
  function renderTransactions(){
    const q=($('transaction-search').value||'').toLowerCase().trim();
    const list=data.transactions.filter(t=>[t.targetName,t.type,t.typeLabel,t.actorEmail,t.accountNumber,t.iin,t.invoiceNumber,t.actorName].some(v=>String(v||'').toLowerCase().includes(q)));
    const pages=Math.max(1,Math.ceil(list.length/pageState.pageSize));pageState.transactions=Math.min(pageState.transactions,pages);const start=(pageState.transactions-1)*pageState.pageSize;const visible=list.slice(start,start+pageState.pageSize);
    $('transactions-table').innerHTML=table(['Дата','Объект','Операция','Расход','Сумма','Способ','Пользователь'],transactionRows(visible),'Операций пока нет');
    const pager=$('transaction-pagination');if(pager)pager.innerHTML=`<button class="btn secondary" ${pageState.transactions<=1?'disabled':''} data-page="prev">Назад</button><span>Страница ${pageState.transactions} из ${pages} · всего ${list.length}</span><button class="btn secondary" ${pageState.transactions>=pages?'disabled':''} data-page="next">Далее</button>`;
  }
  function renderDashboardTransactions(){$('dashboard-transactions').innerHTML=table(['Дата','Объект','Операция','Сумма'],data.transactions.slice(0,5).map(t=>`<tr><td>${escapeHtml(dateText(t.createdAt))}</td><td><strong>${escapeHtml(t.targetName||'—')}</strong></td><td>${escapeHtml(t.typeLabel||t.type||'—')}</td><td>${t.totalSum==null?'—':money(t.totalSum)}</td></tr>`),'Операций пока нет')}
  function renderUsers(){
    if(profile.role!=='admin')return;
    $('users-table').innerHTML=table(['UID','Имя / ИИН','Email','Роль','Показаний проверено','Статус','Действие'],data.users.map(u=>{const count=data.transactions.filter(t=>t.actorUid===u.id&&(t.type==='subscriber_reading'||t.type==='srp_reading')).length;return `<tr><td><code>${escapeHtml(u.id)}</code></td><td><strong>${escapeHtml(u.displayName||'—')}</strong><br><span class="muted">${escapeHtml(u.iin||'')}</span></td><td>${escapeHtml(u.email||'—')}</td><td>${escapeHtml(roles[u.role]||u.role||'—')}</td><td><strong>${count}</strong></td><td><span class="badge ${u.active===false?'off':''}">${u.active===false?'Заблокирован':'Активен'}</span></td><td><button class="btn secondary" data-assign-user="${escapeHtml(u.id)}" data-name="${escapeHtml(u.displayName||'')}">Назначить</button></td></tr>`}),'Профили пользователей не созданы');
  }
  function refreshReadingTargets(){
    const type=$('reading-type').value;
    $('reading-target-label').firstChild.textContent=type==='subscriber'?'Абонент':'Главный ШРП';
    options($('reading-target'),type==='subscriber'?data.subscribers.filter(s=>s.active!==false):data.srps,'Выберите объект',x=>type==='subscriber'?`${x.accountNumber} — ${x.name} (${number(x.currentReading)} м³)`:`${x.name} (${number(x.currentReading)} м³)`);
    $('payment-method-label').classList.toggle('hidden',type!=='subscriber');
    updateCalculation();
  }
  function updateCalculation(){
    const type=$('reading-type').value,id=$('reading-target').value,target=(type==='subscriber'?data.subscribers:data.srps).find(x=>x.id===id),newVal=Number($('reading-value').value);
    if(profile?.role==='dealer'&&type!=='subscriber'){ $('reading-type').value='subscriber'; }
    if(!target||$('reading-value').value===''){ $('calculation-preview').textContent='Выберите объект и введите новое показание для предварительного расчёта.';return; }
    const volume=newVal-Number(target.currentReading||0),srp=type==='subscriber'?data.srps.find(s=>s.id===target.srpId):target,dealer=srp?data.dealers.find(d=>d.id===srp.dealerId):null;
    if(!Number.isFinite(newVal)||newVal<Number(target.currentReading||0)){ $('calculation-preview').textContent=`Ошибка: новое показание должно быть не меньше ${number(target.currentReading)} м³.`;return; }
    const base=volume*Number(data.settings.tariff||0),fee=type==='subscriber'&&$('payment-method').value==='dealer'?Number(dealer?.defaultFee||0):0;
    $('calculation-preview').innerHTML=`Предыдущее: <strong>${number(target.currentReading)} м³</strong><br>Расход: <strong>${number(volume)} м³</strong><br>Стоимость газа: <strong>${money(base)}</strong><br>Комиссия: <strong>${money(fee)}</strong><br>Итого начисление: <strong>${money(base+fee)}</strong>`;
  }
  function switchView(view){
    if(!allowed[view]?.includes(profile.role)){showMessage('У вашей роли нет доступа к этому разделу.','error');return}
    document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));$('view-'+view).classList.remove('hidden');
    document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
    const titles={dashboard:['ОБЗОР','Обзор системы'],dealers:['ИНФРАСТРУКТУРА','Дилеры и ШРП'],subscribers:['РЕЕСТР','Абоненты'],readings:['УЧЁТ ПОТРЕБЛЕНИЯ','Ввод показаний'],transactions:['ФИНАНСЫ','Начисления и операции'],users:['БЕЗОПАСНОСТЬ','Пользователи и роли'],settings:['КОНФИГУРАЦИЯ','Настройки']};
    $('page-eyebrow').textContent=titles[view][0];$('page-title').textContent=titles[view][1];
  }
  async function createDoc(collection,docId,payload){await db.collection(collection).doc(docId).set(payload);await writeAudit('create:'+collection,{docId});}
  async function onForm(formId,fn){$(formId).addEventListener('submit',async e=>{e.preventDefault();setBusy(e.currentTarget,true);try{await fn(e);showMessage('Изменения сохранены.');await refreshData()}catch(err){console.error(err);showMessage(errorText(err),'error')}finally{setBusy(e.currentTarget,false)}})}
  function errorText(e){if(e.code==='permission-denied')return 'Доступ запрещён правилами Firestore. Проверьте профиль роли и Security Rules.';if(e.code==='already-exists')return 'Запись с таким идентификатором уже существует.';return e.message||'Не удалось выполнить операцию.'}
  async function startApp(user){
    currentUser=user;
    const userRef=db.collection('users').doc(user.uid);let snap=await userRef.get();
    if(!snap.exists){await userRef.set({email:user.email||'',displayName:'',role:'client',active:true,createdAt:firebase.firestore.FieldValue.serverTimestamp(),authProvider:'google'});snap=await userRef.get();}
    if(snap.data().active===false){await auth.signOut();$('login-screen').classList.remove('hidden');$('app').classList.add('hidden');setLoginError('Учётная запись заблокирована. Обратитесь к администратору.');return}
    profile={id:snap.id,...snap.data(),email:snap.data().email||user.email};
    if(profile.role==='client'&&!profile.displayName){showProfileSetup();return;}
    if(profile.role==='client'){showPendingRole();return;}
    if(profile.role==='dealer'){const srpOption=$('reading-type').querySelector('option[value="srp"]');if(srpOption)srpOption.disabled=true;$('reading-type').value='subscriber';}
    $('login-screen').classList.add('hidden');$('app').classList.remove('hidden');
    $('user-name').textContent=profile.displayName||user.email||'Пользователь';$('user-role').textContent=roles[profile.role]||profile.role;$('user-avatar').textContent=(profile.displayName||user.email||'U').slice(0,1).toUpperCase();
    document.querySelectorAll('.nav-item').forEach(b=>{const roleList=(b.dataset.roles||'admin,operator,accountant,viewer').split(',');b.classList.toggle('hidden',!roleList.includes(profile.role));});
    document.querySelectorAll('[data-goto]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.goto)));
    try{await refreshData();switchView('dashboard')}catch(e){showMessage(errorText(e),'error')}
  }
  async function init(){
    if(!firebaseReady()){ $('config-warning').classList.remove('hidden');$('login-form').addEventListener('submit',e=>{e.preventDefault();setLoginError('Настройте firebase-config.js перед входом.')});return}
    try{firebase.initializeApp(window.GASCONTROL_FIREBASE_CONFIG);auth=firebase.auth();db=firebase.firestore();auth.onAuthStateChanged(user=>{if(user)startApp(user).catch(e=>{console.error(e);setLoginError(errorText(e))});else{$('app').classList.add('hidden');$('login-screen').classList.remove('hidden');$('login-form').classList.remove('hidden');$('profile-setup-form').classList.add('hidden');$('pending-role').classList.add('hidden');$('login-error').textContent=''}})}
    catch(e){setLoginError('Ошибка инициализации Firebase: '+e.message)}
  }
  $('login-form').addEventListener('submit',async e=>{e.preventDefault();setLoginError('Для входа используйте кнопку «Продолжить с Google».');});
  $('google-login').addEventListener('click',async()=>{setLoginError('');try{const provider=new firebase.auth.GoogleAuthProvider();await auth.signInWithPopup(provider)}catch(err){setLoginError(errorText(err))}});
  function showProfileSetup(){ $('login-form').classList.add('hidden');$('profile-setup').classList.remove('hidden');$('login-error').textContent='';$('profile-email').textContent=currentUser.email||''; }
  function showPendingRole(){ $('login-form').classList.add('hidden');$('profile-setup').classList.add('hidden');$('pending-role').classList.remove('hidden');$('pending-email').textContent=profile.email||'';$('pending-name').textContent=profile.displayName||'Профиль заполнен';$('login-screen').classList.remove('hidden');$('app').classList.add('hidden'); }
  $('profile-setup-form').addEventListener('submit',async e=>{e.preventDefault();const displayName=$('profile-fullname').value.trim(),iin=$('profile-iin').value.trim();if(displayName.length<5){setLoginError('Введите ФИО полностью.');return}try{await db.collection('users').doc(currentUser.uid).set({displayName,iin,email:currentUser.email||'',role:'client',active:true,profileCompletedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});profile={...profile,displayName,iin,role:'client'};showPendingRole()}catch(err){setLoginError(errorText(err))}});
  $('google-logout').addEventListener('click',()=>auth.signOut());
  $('logout-btn').addEventListener('click',()=>auth.signOut());
  $('nav').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(b)switchView(b.dataset.view)});
  $('users-table').addEventListener('click',e=>{const b=e.target.closest('[data-assign-user]');if(!b)return;$('role-uid').value=b.dataset.assignUser;$('role-display-name').value=b.dataset.name||'';$('role-form').scrollIntoView({behavior:'smooth',block:'center'});});
  $('subscriber-search').addEventListener('input',()=>{pageState.subscribers=1;renderSubscribers()});$('transaction-search').addEventListener('input',()=>{pageState.transactions=1;renderTransactions()});
  document.addEventListener('click',e=>{const b=e.target.closest('[data-page]');if(!b||b.disabled)return;const key=b.closest('#subscriber-pagination')?'subscribers':'transactions';pageState[key]+=b.dataset.page==='next'?1:-1;key==='subscribers'?renderSubscribers():renderTransactions()});
  $('reading-type').addEventListener('change',refreshReadingTargets);$('reading-target').addEventListener('change',updateCalculation);$('reading-value').addEventListener('input',updateCalculation);$('payment-method').addEventListener('change',updateCalculation);
  onForm('dealer-form',async()=>{const name=$('dealer-name').value.trim();const id='d_'+crypto.randomUUID();await createDoc('dealers',id,{name,balanceM3:Number($('dealer-balance').value),defaultFee:Number($('dealer-fee').value),createdAt:firebase.firestore.FieldValue.serverTimestamp(),updatedAt:firebase.firestore.FieldValue.serverTimestamp()});$('dealer-form').reset()});
  onForm('srp-form',async()=>{const id='srp_'+crypto.randomUUID(),reading=Number($('srp-reading').value);await createDoc('srps',id,{name:$('srp-name').value.trim(),dealerId:$('srp-dealer').value,currentReading:reading,prevReading:reading,createdAt:firebase.firestore.FieldValue.serverTimestamp(),updatedAt:firebase.firestore.FieldValue.serverTimestamp()});$('srp-form').reset()});
  onForm('subscriber-form',async()=>{
    const accountNumber=$('sub-account').value.trim(),query=await db.collection('subscribers').where('accountNumber','==',accountNumber).limit(1).get();
    if(!query.empty)throw new Error('Лицевой счёт уже существует: '+accountNumber);
    const id='sub_'+crypto.randomUUID(),reading=Number($('sub-reading').value);
    await createDoc('subscribers',id,{accountNumber,name:$('sub-name').value.trim(),address:$('sub-address').value.trim(),phone:$('sub-phone').value.trim(),meterNumber:$('sub-meter').value.trim(),iin:$('sub-iin').value.trim(),invoiceNumber:$('sub-invoice').value.trim(),srpId:$('sub-srp').value,currentReading:reading,prevReading:reading,active:true,createdAt:firebase.firestore.FieldValue.serverTimestamp(),updatedAt:firebase.firestore.FieldValue.serverTimestamp()});$('subscriber-form').reset();
  });
  onForm('reading-form',async()=>{
    const type=$('reading-type').value,id=$('reading-target').value,newVal=Number($('reading-value').value);
    const coll=type==='subscriber'?'subscribers':'srps',ref=db.collection(coll).doc(id);
    await db.runTransaction(async tx=>{
      const snap=await tx.get(ref);if(!snap.exists)throw new Error('Объект не найден. Обновите страницу.');
      const target=snap.data();if(target.active===false)throw new Error('Абонент отключён.');
      const previous=Number(target.currentReading||0);if(newVal<previous)throw new Error('Новое показание не может быть меньше предыдущего.');
      const volume=Number((newVal-previous).toFixed(3)),srp=type==='subscriber'?data.srps.find(s=>s.id===target.srpId):target;
      if(!srp)throw new Error('Для объекта не найден ШРП.');
      const dealerRef=db.collection('dealers').doc(srp.dealerId),dealerSnap=await tx.get(dealerRef),dealer=dealerSnap.exists?dealerSnap.data():null;
      const baseSum=Number((volume*Number(data.settings.tariff||0)).toFixed(2));
      const paymentMethod=type==='subscriber'?$('payment-method').value:'meter_only';
      const fee=type==='subscriber'&&paymentMethod==='dealer'?Number(dealer?.defaultFee||0):0,totalSum=Number((baseSum+fee).toFixed(2));
      if(type==='subscriber'&&paymentMethod==='dealer'&&!dealer)throw new Error('У ШРП не найден дилер. Проверьте привязку.');
      const transactionRef=db.collection('transactions').doc('tx_'+crypto.randomUUID());
      tx.update(ref,{prevReading:previous,currentReading:newVal,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
      /* Volume is recorded against the dealer only for subscriber readings in this build.
         SRP readings are tracked separately to avoid accidental duplicate subtraction at both levels. */
      if(type==='subscriber'&&dealerSnap.exists)tx.update(dealerRef,{balanceM3:Number(dealer.balanceM3||0)-volume,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
      tx.set(transactionRef,{type:type==='subscriber'?'subscriber_reading':'srp_reading',typeLabel:type==='subscriber'?'Начисление абоненту':'Показание ШРП',targetId:id,targetName:target.name||target.accountNumber,volume,previousReading:previous,newReading:newVal,baseSum,fee,totalSum,paymentMethod,paymentMethodLabel:paymentMethod==='dealer'?'Через дилера':paymentMethod==='direct'?'Напрямую':'Без начисления',tariff:Number(data.settings.tariff||0),actorUid:currentUser.uid,actorEmail:currentUser.email||'',actorName:profile.displayName||currentUser.displayName||'',accountNumber:target.accountNumber||'',iin:target.iin||'',invoiceNumber:target.invoiceNumber||'',createdAt:firebase.firestore.FieldValue.serverTimestamp()});
      tx.set(db.collection('auditLogs').doc('audit_'+crypto.randomUUID()),{action:'reading:'+type,targetId:id,actorUid:currentUser.uid,actorEmail:currentUser.email||'',createdAt:firebase.firestore.FieldValue.serverTimestamp()});
    });
    $('reading-form').reset();refreshReadingTargets();showMessage('Показание записано, операция добавлена в историю.');
  });
  onForm('settings-form',async()=>{const tariff=Number($('setting-tariff').value);if(!Number.isFinite(tariff)||tariff<0)throw new Error('Тариф должен быть неотрицательным числом.');await db.collection('settings').doc('main').set({tariff,updatedAt:firebase.firestore.FieldValue.serverTimestamp(),updatedBy:currentUser.uid},{merge:true});await writeAudit('settings:update',{tariff})});
  onForm('role-form',async()=>{const uid=$('role-uid').value.trim(),displayName=$('role-display-name').value.trim(),role=$('role-value').value,active=$('role-active').value==='true';if(!/^(admin|operator|dealer|accountant|viewer)$/.test(role))throw new Error('Недопустимая роль.');await db.collection('users').doc(uid).set({displayName,role,active,updatedAt:firebase.firestore.FieldValue.serverTimestamp(),updatedBy:currentUser.uid},{merge:true});await writeAudit('user:role:update',{uid,role,active});$('role-form').reset()});
  $('subscriber-file').addEventListener('change',()=>{$('selected-file').textContent=$('subscriber-file').files[0]?.name||'Файл не выбран';$('preview-import').disabled=!$('subscriber-file').files.length;$('run-import').disabled=true;$('import-preview').innerHTML='';$('import-status').textContent=''});
  $('preview-import').addEventListener('click',async()=>{
    try{
      const file=$('subscriber-file').files[0];if(!file)throw new Error('Выберите файл.');
      const buf=await file.arrayBuffer(),wb=XLSX.read(buf,{type:'array',cellDates:true}),ws=wb.Sheets[wb.SheetNames[0]],raw=XLSX.utils.sheet_to_json(ws,{defval:'',raw:false});
      if(!raw.length)throw new Error('В файле нет строк данных.');
      const norm=s=>String(s||'').trim().toLowerCase().replace(/[\s_*()-]+/g,'');
      const aliases={
        accountNumber:['accountnumber','лицевойсчёт','лицевойсчет','лицевойсчёт№','лицевойсчет№','лицевойсчётномер','абонентскийномер'],
        name:['name','фио','абонент','фиовладельца','названиеабонента'],
        address:['address','адрес','место'],
        phone:['phone','телефон','номертелефона'],
        meterNumber:['meternumber','номერჃсчётчика','номерсчётчика','номерсчетчика','счётчик','счетчик'],
        srpName:['srpname','шрп','номершрп','названиешрп'],
        currentReading:['currentreading','начальноепоказание','показание','показаниям³','показаниеприборa'],
        iin:['iin','иин','иинабонента'],invoiceNumber:['invoicenumber','счётфактура','счетфактура','номерсчётафактуры','номерсчетафактуры']
      };
      const first=raw[0],map={};Object.keys(first).forEach(k=>{const n=norm(k);for(const [field,alts] of Object.entries(aliases))if(alts.map(norm).includes(n))map[field]=k});
      const required=['accountNumber','name','address','meterNumber','currentReading'];const missing=required.filter(k=>!map[k]);if(missing.length)throw new Error('Не найдены обязательные колонки: '+missing.join(', ')+'. Скачайте шаблон и сохраните заголовки.');
      importRows=raw.map((r,i)=>({row:i+2,accountNumber:String(r[map.accountNumber]||'').trim(),name:String(r[map.name]||'').trim(),address:String(r[map.address]||'').trim(),phone:map.phone?String(r[map.phone]||'').trim():'',iin:map.iin?String(r[map.iin]||'').trim():'',invoiceNumber:map.invoiceNumber?String(r[map.invoiceNumber]||'').trim():'',meterNumber:String(r[map.meterNumber]||'').trim(),srpName:map.srpName?String(r[map.srpName]||'').trim():'',currentReading:Number(String(r[map.currentReading]||'').replace(',','.'))}));
      importIssues=[];const seen=new Set();
      importRows.forEach(r=>{if(!r.accountNumber||!r.name||!r.address||!r.meterNumber||!Number.isFinite(r.currentReading)||r.currentReading<0)importIssues.push({row:r.row,msg:'Пустое обязательное поле или неверное показание'});if(seen.has(r.accountNumber))importIssues.push({row:r.row,msg:'Дубликат лицевого счёта внутри файла'});seen.add(r.accountNumber);if(r.srpName&&!data.srps.some(s=>s.name.toLowerCase()===r.srpName.toLowerCase()))importIssues.push({row:r.row,msg:'ШРП не найден: '+r.srpName})});
      $('import-preview').innerHTML=table(['Строка','Лицевой счёт','Абонент','Адрес','Счётчик','ШРП','Показание'],importRows.slice(0,100).map(r=>`<tr><td>${r.row}</td><td>${escapeHtml(r.accountNumber)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.address)}</td><td>${escapeHtml(r.meterNumber)}</td><td>${escapeHtml(r.srpName||$('import-srp-default').selectedOptions[0]?.textContent||'—')}</td><td>${number(r.currentReading)}</td></tr>`),'Нет строк для импорта');
      $('import-status').textContent=`Прочитано строк: ${importRows.length}. Найдено замечаний: ${importIssues.length}. ${importIssues.slice(0,5).map(x=>`Строка ${x.row}: ${x.msg}`).join(' | ')}`;
      $('run-import').disabled=importRows.length===0||importIssues.some(x=>x.msg.includes('внутри файла')||x.msg.includes('неверное показание')||x.msg.includes('обязательное поле'));
    }catch(e){$('import-status').textContent=errorText(e);$('run-import').disabled=true}
  });
  $('run-import').addEventListener('click',async()=>{
    const btn=$('run-import');btn.disabled=true;btn.textContent='Импорт…';
    try{
      const defaultSrp=$('import-srp-default').value,policy=$('duplicate-policy').value;
      if(!defaultSrp&&importRows.some(r=>!r.srpName))throw new Error('Укажите ШРП по умолчанию или заполните колонку srpName в Excel.');
      const existing=await db.collection('subscribers').get(),byAccount=new Map(existing.docs.map(d=>[String(d.data().accountNumber||''),{id:d.id,...d.data()}]));
      const batch=db.batch();let created=0,updated=0,skipped=0;const now=firebase.firestore.FieldValue.serverTimestamp();
      for(const r of importRows){
        const srp=data.srps.find(s=>s.name.toLowerCase()===r.srpName.toLowerCase())||(defaultSrp?data.srps.find(s=>s.id===defaultSrp):null);
        if(!srp)throw new Error(`Строка ${r.row}: не определён ШРП.`);
        const old=byAccount.get(r.accountNumber);
        if(old&&policy==='skip'){skipped++;continue}
        const payload={accountNumber:r.accountNumber,name:r.name,address:r.address,phone:r.phone,iin:r.iin||'',invoiceNumber:r.invoiceNumber||'',meterNumber:r.meterNumber,srpId:srp.id,currentReading:r.currentReading,prevReading:r.currentReading,active:true,updatedAt:now,importedAt:now,importedBy:currentUser.uid};
        const ref=old?db.collection('subscribers').doc(old.id):db.collection('subscribers').doc('sub_'+crypto.randomUUID());
        if(old){batch.set(ref,payload,{merge:true});updated++}else{batch.set(ref,{...payload,createdAt:now});created++}
      }
      if(created+updated===0){$('import-status').textContent=`Импорт завершён: новых 0, обновлено 0, пропущено ${skipped}.`;return}
      if(created+updated>450)throw new Error('За один импорт разрешено не более 450 записей. Разделите файл на несколько частей.');
      batch.set(db.collection('auditLogs').doc('import_'+crypto.randomUUID()),{action:'subscribers:excel-import',created,updated,skipped,actorUid:currentUser.uid,createdAt:now});
      await batch.commit();await refreshData();$('import-status').textContent=`Импорт завершён. Добавлено: ${created}; обновлено: ${updated}; пропущено: ${skipped}.`;showMessage('Импорт абонентов завершён.');
    }catch(e){$('import-status').textContent=errorText(e);showMessage(errorText(e),'error')}
    finally{btn.disabled=false;btn.textContent='Импортировать проверенные строки'}
  });
  function exportXlsx(name,rows){if(!rows.length){showMessage('Нет данных для экспорта.','error');return}const ws=XLSX.utils.json_to_sheet(rows);const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Данные');XLSX.writeFile(wb,name)}
  $('export-subscribers').addEventListener('click',()=>exportXlsx('абоненты.xlsx',data.subscribers.map(s=>({accountNumber:s.accountNumber,name:s.name,address:s.address,phone:s.phone||'',iin:s.iin||'',invoiceNumber:s.invoiceNumber||'',meterNumber:s.meterNumber,srpName:data.srps.find(x=>x.id===s.srpId)?.name||'',currentReading:s.currentReading,active:s.active!==false}))));
  $('export-dealers').addEventListener('click',()=>exportXlsx('дилеры-и-ШРП.xlsx',data.dealers.map(d=>({dealer:d.name,balanceM3:d.balanceM3,fee:d.defaultFee,srps:data.srps.filter(s=>s.dealerId===d.id).map(s=>s.name).join(', ')}))));
  $('export-transactions').addEventListener('click',()=>exportXlsx('операции.xlsx',data.transactions.map(t=>({date:dateText(t.createdAt),target:t.targetName,type:t.typeLabel||t.type,volume:t.volume,baseSum:t.baseSum,fee:t.fee,totalSum:t.totalSum,tariff:t.tariff,paymentMethod:t.paymentMethodLabel,actor:t.actorEmail}))));
  init();
})();