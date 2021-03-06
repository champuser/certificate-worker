const amqp = require('amqp')
const v4 = require('uuid/v4')
const p = require('path')
const needle = require('needle')
const moment = require('moment-timezone')
const fs = require('fs')
const Handlebars = require('handlebars')

const Raven = require('./raven')
const { uploadToMinio, linkForKey } = require('./minio')
const config = require('./config')
const pdf = require('./utils/pdf');

Handlebars.registerHelper('eq', (a,b) => {
  return a==b
})

// set default timezone
moment.tz.setDefault('Asia/Kolkata');

const connection = amqp.createConnection({
  host: config.host,
  login: config.login,
  password: config.password,
  port: config.port
}) 

connection.on('error', function (e) {
  console.error("Error from amqp: ", e)
})

connection.on('close', function (e) {
  process.exit(1) // exit with non zero error code -> make container crash 
})

const queuePromise = new Promise((resolve, reject) => {
  connection.on('ready', function () {
    connection.queue('amoeba-certificate', {durable: true, autoDelete: false}, q => {
      resolve(q)
    })
  })
})

queuePromise.then(q => {
  // Catch all messages
  q.bind('#');

  // Receive messages
  q.subscribe(async function ({ data, callback }) {
    try {
      data.salt = v4().slice(-4)
      data.run.startString =  moment.unix(data.run.start).format("MMM YYYY")
      data.run.endString = moment.unix(data.run.end).format("MMM YYYY")

      data.user.firstname = data.user.firstname.toLowerCase()
      data.user.lastname = data.user.lastname.toLowerCase()
      
      // 1. generate html
      const path = p.join(__dirname, './certification/' + v4() + ".pdf")
      const templatePath = p.join(__dirname, './templates/' + data.template + '.hbs')

      console.log(data.run)

      const document = {
          template: fs.readFileSync(templatePath).toString('utf-8'),
          context: {
            data
          },
          options: {
	      height: '595px', 
	      width: '842px',
              printBackground: true,
              path: path  
          }
      };

      const template = Handlebars.compile(document.template);
      let html = template(document.context);
      //Adding base tag in html to fetch static content from localhost
      const base = `<base href="http://localhost:8000/">`;
      html = html.replace(/(?:\<style\>)/, base + '<style>');

      //sending html and pdf option to puppeteer
      await pdf.createPdf(html, document.options);

      // 2. Upload to minio
      const destKeyName = `${data.name.replace(' ', '')}_${v4()}`
      await uploadToMinio(path, destKeyName)

      // 3. Send event via webhook
      const webhookPayload = {
        secret: config.appSecret,
        certificateId: data.certificateId,
        url: linkForKey(destKeyName),
        salt: data.salt
      }
	
      await needle('patch', callback, webhookPayload, { json: true })

      // 4. Cleanup
      fs.unlinkSync(path)
    } catch (err) {

      // If we get any error, let the webhook know about it
      Raven.captureException(err)
      await needle('patch', callback, {
        certificateId: data.certificateId,
        secret: config.appSecret,
        error: err
      }, { json: true })
    }
  });
})


