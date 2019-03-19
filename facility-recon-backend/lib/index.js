require('./init');
const cluster = require('cluster');
const express = require('express');
const path = require('path')
const bodyParser = require('body-parser');
const formidable = require('formidable');
const winston = require('winston');
const https = require('https');
const http = require('http');
const os = require("os");
const fs = require("fs");
const request = require('request');
const fsFinder = require('fs-finder')
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const redis = require('redis');
const redisClient = redis.createClient({
  host: process.env.REDIS_HOST || '127.0.0.1'
});
const moment = require("moment")
const json2csv = require('json2csv').parse;
const csv = require('fast-csv');
const url = require('url');
const async = require('async');
const mongoose = require('mongoose');
const models = require('./models')
const mixin = require('./mixin')()
const mongo = require('./mongo')();
const config = require('./config');
const mcsd = require('./mcsd')();
const dhis = require('./dhis')();
const fhir = require('./fhir')();
const scores = require('./scores')();

const mongoUser = config.getConf("DB_USER")
const mongoPasswd = config.getConf("DB_PASSWORD")
const mongoHost = config.getConf("DB_HOST")
const mongoPort = config.getConf("DB_PORT")

const app = express();
const server = require('http').createServer(app);

let cleanReqPath = function (req, res, next) {
  let modified_url = req.url.replace("/gofr", '')
  if (modified_url) {
    req.url = req.url.replace('/gofr', '')
  }
  return next()
}

let jwtValidator = function (req, res, next) {
  if (req.method == "OPTIONS" ||
    req.path == "/authenticate/" ||
    req.path == "/getSignupConf" ||
    req.path == "/getGeneralConfig" ||
    req.path == "/signup/" ||
    req.path == "/gofr" ||
    req.path.startsWith("/static/js") ||
    req.path.startsWith("/static/css") ||
    req.path.startsWith("/static/img")
  ) {
    return next()
  }
  if (!req.headers.authorization || req.headers.authorization.split(' ').length !== 2) {
    winston.error("Token is missing")
    res.set('Access-Control-Allow-Origin', '*')
    res.set('WWW-Authenticate', 'Bearer realm="Token is required"')
    res.set('charset', 'utf - 8')
    res.status(401).json({
      error: 'Token is missing'
    })
  } else {
    tokenArray = req.headers.authorization.split(' ')
    let token = req.headers.authorization = tokenArray[1]
    jwt.verify(token, config.getConf('auth:secret'), (err, decoded) => {
      if (err) {
        winston.warn("Token expired")
        res.set('Access-Control-Allow-Origin', '*')
        res.set('WWW-Authenticate', 'Bearer realm="Token expired"')
        res.set('charset', 'utf - 8')
        res.status(401).json({
          error: 'Token expired'
        })
      } else {
        // winston.info("token is valid")
        if (req.path == "/isTokenActive/") {
          res.set('Access-Control-Allow-Origin', '*')
          res.status(200).send(true)
        } else {
          return next()
        }
      }
    })
  }
}

app.use(cleanReqPath)
app.use(jwtValidator)
app.use(express.static(__dirname + '/../gui'));
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(bodyParser.urlencoded({
  extended: true,
}));
app.use(bodyParser.json());
// socket config - large documents can cause machine to max files open

https.globalAgent.maxSockets = 32;
http.globalAgent.maxSockets = 32;

const topOrgId = config.getConf('mCSD:fakeOrgId')
const topOrgName = config.getConf('mCSD:fakeOrgName')

if (cluster.isMaster) {
  var workers = {};
  const database = config.getConf("DB_NAME")
  if (mongoUser && mongoPasswd) {
    var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
  } else {
    var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
  }
  mongoose.connect(uri);
  let db = mongoose.connection
  db.on("error", console.error.bind(console, "connection error:"))
  db.once("open", () => {
    models.UsersModel.find({
      userName: "root@gofr.org"
    }).lean().exec((err, data) => {
      if (data.length == 0) {
        winston.info("Default user not found, adding now ...")
        let roles = [{
            "name": "Admin"
          },
          {
            "name": "Data Manager"
          }
        ]
        models.RolesModel.collection.insertMany(roles, (err, data) => {
          models.RolesModel.find({
            name: "Admin"
          }, (err, data) => {
            let User = new models.UsersModel({
              firstName: "Root",
              surname: "Root",
              userName: "root@gofr.org",
              status: "Active",
              role: data[0]._id,
              password: bcrypt.hashSync("gofr", 8)
            })
            User.save((err, data) => {
              if (err) {
                winston.error(err)
                winston.error('Unexpected error occured,please retry')
              } else {
                winston.info('Admin User added successfully')
              }
            })
          })
        })
      }
    })
  })

  var numWorkers = require('os').cpus().length;
  console.log('Master cluster setting up ' + numWorkers + ' workers...');

  for (var i = 0; i < numWorkers; i++) {
    const worker = cluster.fork();
    workers[worker.process.pid] = worker;
  }

  cluster.on('online', function (worker) {
    console.log('Worker ' + worker.process.pid + ' is online');
  });

  cluster.on('exit', function (worker, code, signal) {
    console.log('Worker ' + worker.process.pid + ' died with code: ' + code + ', and signal: ' + signal);
    delete(workers[worker.process.pid]);
    console.log('Starting a new worker');
    const newworker = cluster.fork();
    workers[newworker.process.pid] = newworker;
  });
  cluster.on('message', (worker, message) => {
    winston.info('Master received message from ' + worker.process.pid);
    if (message.content === 'clean') {
      for (let i in workers) {
        if (workers[i].process.pid !== worker.process.pid) {
          workers[i].send(message);
        } else {
          winston.info("Not sending clean message to self: " + i);
        }
      }
    }
  });
} else {
  process.on('message', (message) => {
    if (message.content === 'clean') {
      winston.info(process.pid + " received clean message from master.")
      mcsd.cleanCache(message.url, true)
    }
  })
  const levelMaps = {
    'ds0ADyc9UCU': { // Cote D'Ivoire
      4: 5,
    }
  }

  app.get('/doubleMapping/:db', (req, res) => {
    winston.info('Received a request to check Source1 Locations that are double mapped')
    let source1DB = req.params.db
    let mappingDB = config.getConf('mapping:dbPrefix') + req.params.db
    async.parallel({
      source1Data: function (callback) {
        mcsd.getLocations(source1DB, (data) => {
          return callback(false, data)
        })
      },
      mappingData: function (callback) {
        mcsd.getLocations(mappingDB, (data) => {
          return callback(false, data)
        })
      }
    }, (err, results) => {
      let dupplicated = []
      let url = 'http://localhost:3447/' + source1DB + '/fhir/Location/'
      async.each(results.source1Data.entry, (source1Entry, nxtSource1) => {
        source1id = source1Entry.resource.id
        let checkDup = []
        async.each(results.mappingData.entry, (mappingEntry, nxtMap) => {
          var isMapped = mappingEntry.resource.identifier.find((ident) => {
            return ident.system === 'https://digitalhealth.intrahealth.org/source1' && ident.value === url + source1id
          })
          if (isMapped) {
            checkDup.push({
              source1Name: source1Entry.resource.name,
              source1ID: source1Entry.resource.id,
              source2Name: mappingEntry.resource.name,
              source2ID: mappingEntry.resource.id
            })
          }
          return nxtMap()
        }, () => {
          if (checkDup.length > 1) {
            dupplicated.push(checkDup)
          }
          return nxtSource1()
        })
      }, () => {
        winston.info('Found ' + dupplicated.length + ' Source1 Locations with Double Matching')
        res.send(dupplicated)
      })
    })
  })

  app.post('/authenticate', (req, res) => {
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      winston.info('Authenticating user ' + fields.username)
      const database = config.getConf("DB_NAME")
      const mongoUser = config.getConf("DB_USER")
      const mongoPasswd = config.getConf("DB_PASSWORD")
      const mongoHost = config.getConf("DB_HOST")
      const mongoPort = config.getConf("DB_PORT")

      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
      }
      mongoose.connect(uri);
      let db = mongoose.connection
      db.on("error", console.error.bind(console, "connection error:"))
      db.once("open", () => {
        models.UsersModel.find({
          userName: fields.username,
          $or: [{
            status: 'Active'
          }, {
            status: ''
          }, {
            status: undefined
          }]
        }).lean().exec((err, data) => {
          if (data.length === 1) {
            let userID = data[0]._id.toString()
            let passwordMatch = bcrypt.compareSync(fields.password, data[0].password);
            if (passwordMatch) {
              let tokenDuration = config.getConf('auth:tokenDuration')
              let secret = config.getConf('auth:secret')
              let token = jwt.sign({
                id: data[0]._id.toString()
              }, secret, {
                expiresIn: tokenDuration
              })
              // get role name
              models.RolesModel.find({
                _id: data[0].role
              }).lean().exec((err, roles) => {
                let role = null
                if (roles.length === 1) {
                  role = roles[0].name
                }
                winston.info('Successfully Authenticated user ' + fields.username)
                res.status(200).json({
                  token,
                  role,
                  userID
                })
              })
            } else {
              winston.info('Failed Authenticating user ' + fields.username)
              res.status(200).json({
                token: null,
                role: null,
                userID: null
              })
            }
          } else {
            winston.info('Failed Authenticating user ' + fields.username)
            res.status(200).json({
              token: null,
              role: null,
              userID: null
            })
          }
        })
      })
    })
  })

  app.post('/addUser', (req, res) => {
    winston.info("Received a signup request")
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      const database = config.getConf("DB_NAME")

      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
      }
      mongoose.connect(uri, {}, () => {
        models.MetaDataModel.find({
          "forms.name": "signup"
        }, (err, data) => {
          if (data) {
            let signupFields = {}
            if(data.length > 0) {
              signupFields = Object.assign({}, data[0].forms[0].fields)
            }
            signupFields = Object.assign(signupFields, models.usersFields)

            models.RolesModel.find({
              name: "Data Manager"
            }, (err, data) => {
              if (data) {
                let schemaData = {}
                for (let field in signupFields) {
                  if(field === 'password') {
                    fields[field] = bcrypt.hashSync(fields.password, 8)
                  }
                  schemaData[field] = fields[field]
                }
                if(!schemaData.hasOwnProperty('role') || !schemaData.role) {
                  schemaData.role = data[0]._id
                }
                schemaData.status = "Active"
                const Users = new models.UsersModel(schemaData)
                Users.save((err, data) => {
                  if (err) {
                    winston.error(err)
                    res.status(500).json({
                      error: "Internal error occured"
                    })
                  } else {
                    res.status(200).send()
                  }
                })
              } else {
                if (err) {
                  winston.error(err)
                }
                res.status(500).json({
                  error: "Internal error occured"
                })
              }
            })
          } else {
            if (err) {
              winston.error(err)
            }
            res.status(500).json({
              error: "Internal error occured"
            })
          }
        })
      })
    })
  })

  app.post('/addUser1', (req, res) => {
    winston.info("Received a request to add a new user")
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      const database = config.getConf("DB_NAME")

      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
      }
      mongoose.connect(uri);
      let db = mongoose.connection
      db.on("error", console.error.bind(console, "connection error:"))
      db.once("open", () => {
        let User = new models.UsersModel({
          _id: new mongoose.Types.ObjectId(),
          role: fields.role,
          firstName: fields.firstname,
          otherName: fields.othername,
          surname: fields.surname,
          password: bcrypt.hashSync(fields.password, 8),
          userName: fields.username,
          status: 'Active'
        })
        User.save((err, data) => {
          if (err) {
            winston.error(err)
            winston.error('Unexpected error occured,please retry')
            res.status(400).send()
          } else {
            winston.info('User added successfully')
            res.status(200).send()
          }
        })
      })
    })
  })

  app.get('/getUsers', (req, res) => {
    winston.info("received a request to get users lists")
    const database = config.getConf("DB_NAME")
    if (mongoUser && mongoPasswd) {
      var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
    } else {
      var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
    }
    mongoose.connect(uri);
    let db = mongoose.connection
    db.on("error", console.error.bind(console, "connection error:"))
    db.once("open", () => {
      models.UsersModel.find({}).populate("role").lean().exec((err, users) => {
        winston.info(`sending back a list of ${users.length} users`)
        res.status(200).json(users)
      })
    })
  })

  app.post('/changeAccountStatus', (req, res) => {
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      winston.info("Received a request to " + fields.status + ' account for userID ' + fields.id)
      mongo.changeAccountStatus(fields.status, fields.id, (error, resp) => {
        if (error) {
          winston.error(error)
          return res.status(400).send()
        } else {
          res.status(200).send()
        }
      })
    })
  })

  app.post('/resetPassword', (req, res) => {
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      winston.info("Received a request to reset password for userID " + fields.id)
      mongo.resetPassword(fields.id, bcrypt.hashSync(fields.surname, 8), (error, resp) => {
        if (error) {
          winston.error(error)
          return res.status(400).send()
        } else {
          res.status(200).send()
        }
      })
    })
  })

  app.post('/changePassword', (req, res) => {
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      winston.info("Received a request to change password for userID " + fields.id)
      mongo.resetPassword(fields.id, bcrypt.hashSync(fields.password, 8), (error, resp) => {
        if (error) {
          winston.error(error)
          return res.status(400).send()
        } else {
          res.status(200).send()
        }
      })
    })
  })

  app.post('/shareSourcePair', (req, res) => {
    winston.info("Received a request to share data source pair")
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      fields.users = JSON.parse(fields.users)
      mongo.shareSourcePair(fields.sharePair, fields.users, (err, response) => {
        if (err) {
          winston.error(err)
          winston.error("An error occured while sharing data source pair")
          res.status(500).send("An error occured while sharing data source pair")
        } else {
          winston.info("Data source pair shared successfully")
          mongo.getDataSourcePair(fields.userID, (err, pairs) => {
            if (err) {
              winston.error(err)
              winston.error("An error has occured while getting data source pairs")
              res.status(500).send("An error has occured while getting data source pairs")
              return
            }
            res.status(200).json(pairs)
          })
        }
      })
    })
  })

  function getLastUpdateTime(sources, callback) {
    sources = JSON.parse(JSON.stringify(sources))
    async.eachOfSeries(sources, (server, key, nxtServer) => {
      if (server.sourceType === 'FHIR') {
        let database = mixin.toTitleCase(server.name) + server.userID._id
        fhir.getLastUpdate(database, (lastUpdate) => {
          if (lastUpdate) {
            sources[key]["lastUpdate"] = lastUpdate
          }
          return nxtServer()
        })
      } else if (server.sourceType === 'DHIS2') {
        let password = ''
        if (server.password) {
          password = mongo.decrypt(server.password)
        }
        const auth = `Basic ${Buffer.from(`${server.username}:${password}`).toString('base64')}`
        const dhis2URL = url.parse(server.host)
        let database = mixin.toTitleCase(server.name) + server.userID._id
        dhis.getLastUpdate(database, dhis2URL, auth, (lastUpdate) => {
          if (lastUpdate) {
            lastUpdate = lastUpdate.split('.').shift()
            sources[key]["lastUpdate"] = lastUpdate
          }
          return nxtServer()
        })
      } else {
        return nxtServer()
      }
    }, () => {
      return callback(sources)
    })
  }

  app.post('/shareDataSource', (req, res) => {
    winston.info("Received a request to share data source")
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      fields.users = JSON.parse(fields.users)
      let limitLocationId = fields.limitLocationId
      mongo.shareDataSource(fields.shareSource, fields.users, limitLocationId, (err, response) => {
        if (err) {
          winston.error(err)
          winston.error("An error occured while sharing data source")
          res.status(500).send("An error occured while sharing data source")
        } else {
          winston.info("Data source shared successfully")
          mongo.getDataSources(fields.userID, (err, sources) => {
            getLastUpdateTime(sources, (sources) => {
              if (err) {
                winston.error(err)
                winston.error("An error has occured while getting data source")
                res.status(500).send("An error has occured while getting data source")
                return
              }
              winston.info('returning list of data sources ' + JSON.stringify(sources))
              res.status(200).json(sources)
            })
          })
        }
      })
    })
  })

  app.post('/updateUserConfig', (req, res) => {
    winston.info("Received updated user configurations")
    const database = config.getConf("DB_NAME")
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      const mongoose = require('mongoose')
      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
      }
      let appConfig
      try {
        appConfig = JSON.parse(fields.config)
      } catch (error) {
        appConfig = fields.config
      }
      appConfig.userConfig.userID = fields.userID
      mongoose.connect(uri, {}, () => {
        models.MetaDataModel.findOne({
          'config.userConfig.userID': fields.userID
        }, (err, data) => {
          if (!data) {
            models.MetaDataModel.findOne({}, {_id: 1}, (err, data) => {
              if (data) {
                models.MetaDataModel.findByIdAndUpdate(data._id, {$push: {'config.userConfig': appConfig.userConfig}}, (err, data) => {
                  if (err) {
                    winston.error(err)
                    winston.error("Failed to save new config")
                    res.status(500).json({
                      error: 'Unexpected error occured,please retry'
                    });
                  } else {
                    winston.info("New config saved successfully")
                    res.status(200).json({
                      status: 'Done'
                    });
                  }
                })
              } else {
                const MetaData = new models.MetaDataModel({'config.userConfig': appConfig.userConfig});
                MetaData.save((err, data) => {
                  if (err) {
                    winston.error(err)
                    winston.error("Failed to save new config")
                    res.status(500).json({
                      error: 'Unexpected error occured,please retry'
                    });
                  } else {
                    winston.info("New config saved successfully")
                    res.status(200).json({
                      status: 'Done'
                    });
                  }
                })
              }
            })
          } else {
            models.MetaDataModel.findOneAndUpdate({_id: data.id, 'config.userConfig._id': appConfig.userConfig._id}, 
            {$set: {'config.userConfig': appConfig.userConfig}}, (err, data) => {
              if (err) {
                winston.error(err)
                winston.error("Failed to save new config")
                res.status(500).json({
                  error: 'Unexpected error occured,please retry'
                });
              } else {
                winston.info("New config saved successfully")
                res.status(200).json({
                  status: 'Done'
                });
              }
            })
          }
        })
      })
    })
  })

  app.post('/updateGeneralConfig', (req, res) => {
    winston.info("Received updated general configurations")
    const database = config.getConf("DB_NAME")
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      const mongoose = require('mongoose')
      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
      }
      let appConfig
      try {
        appConfig = JSON.parse(fields.config)
      } catch (error) {
        appConfig = fields.config
      }
      mongoose.connect(uri, {}, () => {
        models.MetaDataModel.findOne({}, (err, data) => {
          if (!data) {
            const MetaData = new models.MetaDataModel({
              'config.generalConfig': appConfig.generalConfig
            });
            MetaData.save((err, data) => {
              if (err) {
                winston.error(err)
                winston.error("Failed to save new config")
                res.status(500).json({
                  error: 'Unexpected error occured,please retry'
                });
              } else {
                winston.info("New config saved successfully")
                res.status(200).json({
                  status: 'Done'
                });
              }
            })
          } else {
            models.MetaDataModel.findByIdAndUpdate(data.id, {
              'config.generalConfig': appConfig.generalConfig
            }, (err, data) => {
              if (err) {
                winston.error(err)
                winston.error("Failed to save new general config")
                res.status(500).json({
                  error: 'Unexpected error occured,please retry'
                });
              } else {
                winston.info("New general config saved successfully")
                res.status(200).json({
                  status: 'Done'
                });
              }
            })
          }
        })
      })
    })
  })

  app.get('/getUserConfig/:userID', (req, res) => {
    let database = config.getConf("DB_NAME")
    let userID = req.params.userID
    const mongoose = require('mongoose')
    if (mongoUser && mongoPasswd) {
      var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
    } else {
      var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
    }
    mongoose.connect(uri, {}, () => {
      models.MetaDataModel.findOne({}, {'config.userConfig': 1}, (err, data) => {
        if(!data) {
          return res.status(200).send()
        }
        let userConfig = data.config.userConfig.find((userConfigData) => {
          let userConfig = {}
          try {
            userConfig = JSON.parse(JSON.stringify(userConfigData))
          } catch (error) {
            winston.error(error)
          }
          return userConfig.userID === userID
        })
        if (err) {
          winston.error(err)
          res.status(500).json({
            error: 'internal error occured while getting configurations'
          })
        } else {
          if(data) {
            delete data._id
            delete data.config.userConfig.userID
          }
          res.status(200).json(userConfig)
        }
      })
    })
  })

  app.get('/getGeneralConfig', (req, res) => {
    let database = config.getConf("DB_NAME")
    const mongoose = require('mongoose')
    if (mongoUser && mongoPasswd) {
      var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
    } else {
      var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
    }
    mongoose.connect(uri, {}, () => {
      models.MetaDataModel.findOne({},{'config.generalConfig': 1}, (err, data) => {
        if (err) {
          winston.error(err)
          res.status(500).json({
            error: 'internal error occured while getting configurations'
          })
        } else {
          res.status(200).json(data)
        }
      })
    })
  })

  app.get('/getGeneralConfig', (req, res) => {
    let database = config.getConf("DB_NAME")
    let userID = req.params.userID
    const mongoose = require('mongoose')
    if (mongoUser && mongoPasswd) {
      var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
    } else {
      var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
    }
    mongoose.connect(uri, {}, () => {
      models.MetaDataModel.findOne({}, {'config.generalConfig': 1}, (err, data) => {
        if (err) {
          winston.error(err)
          res.status(500).json({
            error: 'internal error occured while getting configurations'
          })
        } else {
          res.status(200).json(data)
        }
      })
    })
  })

  app.post('/addFormField', (req, res) => {
    const database = config.getConf("DB_NAME")
    const form = new formidable.IncomingForm();

    form.parse(req, (err, fields, files) => {
      const mongoose = require('mongoose')
      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
      }

      let fieldName = fields.fieldName
      let fieldLabel = fields.fieldLabel

      let required
      try {
        required = JSON.parse(fields.fieldRequired)
      } catch (error) {
        winston.error(error)
        required = false
      }
      let formName = fields.form
      mongoose.connect(uri, {}, () => {
        models.MetaDataModel.findOne({
          'forms.name': formName
        }, (err, form) => {
          if (err) {
            winston.error(err)
            res.status(500).json({
              error: 'internal error occured while getting form fields'
            })
          } else {
            let customFields = {}
            if(form) {
              customFields = form.forms[0].fields
            }
            customFields[fieldName] = {
              type: "String",
              required: required,
              display: fieldLabel
            }
            const promises = []

            promises.push(new Promise((resolve, reject) => {
              if(!form) {
                models.MetaDataModel.find({},{_id: 1}).lean().exec( (err, mtDt) => {
                  let form = {
                    name: formName,
                    fields: customFields
                  }
                  if(err) {
                    return resolve(err, null)
                  }
                  models.MetaDataModel.findByIdAndUpdate(mtDt[0]._id, {$push: {'forms': form}}, (err, data) => {
                    if(err) {
                      return resolve(err, null)
                    } else {
                      return resolve(null, data)
                    }
                  })
                })
              } else {
                models.MetaDataModel.update({
                  'forms.name': formName
                }, {
                  $set: {
                    'forms.$.fields': customFields
                  }
                }, (err, data) => {
                  if(err) {
                    return resolve(err, null)
                  } else {
                    return resolve(null, data)
                  }
                })
              }
            }))

            Promise.all(promises).then((results) => {
              if (results[0]) {
                winston.error(results[0])
                winston.error("Failed to save new field")
                res.status(500).json({
                  error: 'Unexpected error occured,please retry'
                });
              } else {
                delete mongoose.connection.models['Users']
                let usersFields = Object.assign({}, customFields)
                usersFields = Object.assign(usersFields, models.usersFields)
                Users = new mongoose.Schema(usersFields)
                models.UsersModel = mongoose.model('Users', Users)
                winston.info("Field added successfully")
                res.status(200).json({
                  status: 'Done'
                });
              }
            }).catch((err) => {
              winston.error(err)
            })
          }
        })
      })
    })
  })

  app.get('/getSignupConf', (req, res) => {
    const database = config.getConf("DB_NAME")
    if (mongoUser && mongoPasswd) {
      var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
    } else {
      var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
    }
    mongoose.connect(uri, {}, () => {
      models.MetaDataModel.findOne({
        'forms.name': 'signup'
      }, (err, form) => {
        if (err) {
          winston.error(err)
          res.status(500).json({
            error: 'internal error occured while getting configurations'
          })
        } else {
          let customFields = {}
          if(form) {
            customFields = form.forms[0].fields
          }
          let allFields = Object.assign({}, models.usersFields)
          allFields = Object.assign(allFields, customFields)
          res.status(200).json({
            customSignupFields: customFields,
            originalSignupFields: models.usersFields,
            allSignupFields: allFields
          })
        }
      })
    })
  })

  app.get('/getRoles/:id?', (req, res) => {
    winston.info("Received a request to get roles")
    const database = config.getConf("DB_NAME")

    if (mongoUser && mongoPasswd) {
      var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
    } else {
      var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
    }
    mongoose.connect(uri);
    let db = mongoose.connection
    db.on("error", console.error.bind(console, "connection error:"))
    db.once("open", () => {
      let idFilter
      if (req.params.id) {
        idFilter = {
          _id: req.params.id
        }
      } else {
        idFilter = {}
      }
      models.RolesModel.find(idFilter).lean().exec((err, roles) => {
        winston.info(`sending back a list of ${roles.length} roles`)
        res.status(200).json(roles)
      })
    })
  })

  app.get('/countLevels/:source1/:source2/:sourcesOwner/:sourcesLimitOrgId', (req, res) => {
    winston.info(`Received a request to get total levels`);
    let sourcesOwner = JSON.parse(req.params.sourcesOwner)
    let source1Owner = sourcesOwner.source1Owner
    let source2Owner = sourcesOwner.source2Owner
    let sourcesLimitOrgId = JSON.parse(req.params.sourcesLimitOrgId)
    let source1LimitOrgId = sourcesLimitOrgId.source1LimitOrgId
    let source2LimitOrgId = sourcesLimitOrgId.source2LimitOrgId
    if(!source1LimitOrgId) {
      source1LimitOrgId = topOrgId
    }
    if(!source2LimitOrgId) {
      source2LimitOrgId = topOrgId
    }
    let source1 = req.params.source1 + source1Owner
    let source2 = req.params.source2 + source2Owner
    async.parallel({
      Source1Levels: function (callback) {
        mcsd.countLevels(source1, source1LimitOrgId, (err, source1TotalLevels) => {
          winston.info(`Received total source1 levels of ${source1TotalLevels}`);
          return callback(err, source1TotalLevels)
        })
      },
      Source2Levels: function (callback) {
        mcsd.countLevels(source2, source2LimitOrgId, (err, source2TotalLevels) => {
          winston.info(`Received total source2 levels of ${source2TotalLevels}`);
          return callback(err, source2TotalLevels)
        })
      },
      getLevelMapping: function (callback) {
        async.series({
          levelMapping1: function (callback) {
            mongo.getLevelMapping(source1, (levelMappingData) => {
              let levelMapping = {}
              if (levelMappingData) {
                for (let level in levelMappingData) {
                  let levelData = levelMappingData[level]
                  try {
                    levelData = JSON.parse(levelData)
                  } catch (error) {
    
                  }
                  if (levelData && levelData !== 'undefined' && level != '$init') {
                    levelMapping[level] = levelMappingData[level]
                  }
                }
              }
              return callback(false, levelMapping)
            })
          },
          levelMapping2: function (callback) {
            mongo.getLevelMapping(source2, (levelMappingData) => {
              let levelMapping = {}
              if (levelMappingData) {
                for (let level in levelMappingData) {
                  let levelData = levelMappingData[level]
                  try {
                    levelData = JSON.parse(levelData)
                  } catch (error) {
    
                  }
                  if (levelData && levelData !== 'undefined' && level != '$init') {
                    levelMapping[level] = levelMappingData[level]
                  }
                }
              }
              return callback(false, levelMapping)
            })
          }
        }, (err, mappings) => {
          return callback(false, mappings)
        })
      }
    }, (err, results) => {
      if (err) {
        winston.error(err);
        res.status(400).json({
          error: err
        });
      } else {
        const recoLevel = 2;
        res.status(200).json({
          totalSource1Levels: results.Source1Levels,
          totalSource2Levels: results.Source2Levels,
          recoLevel,
          levelMapping: results.getLevelMapping
        });
      }
    })
  });

  app.get('/getLevelData/:source/:sourceOwner/:level', (req, res) => {
    let sourceOwner = req.params.sourceOwner
    let db = req.params.source + sourceOwner;
    let level = req.params.level
    let levelData = []
    mcsd.getLocations(db, (mcsdData) => {
      mcsd.filterLocations(mcsdData, topOrgId, level, (mcsdLevelData) => {
        async.each(mcsdLevelData.entry, (data, nxtData) => {
          levelData.push({
            text: data.resource.name,
            value: data.resource.id
          })
          return nxtData()
        }, () => {
          res.status(200).json(levelData)
        })
      });
    });
  })

  app.post('/editLocation', (req, res) => {
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      let db = fields.source + fields.sourceOwner
      let id = fields.locationId
      let name = fields.locationName
      let parent = fields.locationParent
      mcsd.editLocation(id, name, parent, db, (resp, err) => {
        if (err) {
          res.status(400).send(err)
        } else {
          res.status(200).send()
        }
      })
    })
  })

  app.delete('/deleteLocation', (req, res) => {
    let id = req.query.id
    let source = req.query.source
    let sourceOwner = req.query.sourceOwner
    let userID = req.query.userID
    mcsd.deleteLocation(id, source, sourceOwner, userID, (resp, err) => {
      if (err) {
        res.status(400).send(err)
      } else {
        res.status(200).send()
      }
    })
  })

  app.get('/uploadAvailable/:source1/:source2/:source1Owner/:source2Owner', (req, res) => {
    if (!req.params.source1 || !req.params.source2) {
      winston.error({
        error: 'Missing Orgid'
      });
      res.set('Access-Control-Allow-Origin', '*');
      res.status(400).json({
        error: 'Missing Orgid'
      });
    } else {
      let source1Owner = req.params.source1Owner
      let source2Owner = req.params.source2Owner
      const source1 = req.params.source1 + source1Owner;
      const source2 = req.params.source2 + source2Owner;
      winston.info(`Checking if data available for ${source1} and ${source2}`);
      async.parallel({
        source1Availability: function (callback) {
          mcsd.getLocations(source1, (source1Data) => {
            if (source1Data.hasOwnProperty('entry') && source1Data.entry.length > 0) {
              return callback(false, true)
            } else {
              return callback(false, false)
            }
          })
        },
        source2Availability: function (callback) {
          mcsd.getLocations(source2, (source2Data) => {
            if (source2Data.hasOwnProperty('entry') && source2Data.entry.length > 0) {
              return callback(false, true)
            } else {
              return callback(false, false)
            }
          })
        }
      }, (error, results) => {
        if (results.source1Availability && results.source2Availability) {
          res.status(200).json({
            dataUploaded: true
          });
        } else {
          res.status(200).json({
            dataUploaded: false
          });
        }
      })
    }
  });

  app.get('/getArchives/:orgid', (req, res) => {
    if (!req.params.orgid) {
      winston.error({
        error: 'Missing Orgid'
      });
      res.set('Access-Control-Allow-Origin', '*');
      res.status(400).json({
        error: 'Missing Orgid'
      });
    } else {
      const orgid = req.params.orgid;
      winston.info(`Getting archived DB for ${orgid}`);
      mongo.getArchives(orgid, (err, archives) => {
        res.set('Access-Control-Allow-Origin', '*');
        if (err) {
          winston.error(err)
          winston.error({
            error: 'Unexpected error has occured'
          });
          res.status(400).json({
            error: 'Unexpected error'
          });
          return
        }
        res.status(200).json(archives)
      })
    }
  });

  app.post('/restoreArchive/:orgid', (req, res) => {
    if (!req.params.orgid) {
      winston.error({
        error: 'Missing Orgid'
      });
      res.set('Access-Control-Allow-Origin', '*');
      res.status(400).json({
        error: 'Missing Orgid'
      });
    } else {
      const orgid = req.params.orgid;
      winston.info(`Restoring archive DB for ${orgid}`);
      const form = new formidable.IncomingForm();
      form.parse(req, (err, fields, files) => {
        mongo.restoreDB(fields.archive, orgid, (err) => {
          res.set('Access-Control-Allow-Origin', '*');
          if (err) {
            winston.error(err)
            res.status(400).json({
              error: 'Unexpected error occured while restoring the database,please retry'
            });
          }
          res.status(200).send();
        })
      })
    }
  });

  app.post('/dhisSync', (req, res) => {
    winston.info('received request to sync DHIS2 data');
    const form = new formidable.IncomingForm();
    res.status(200).end();
    form.parse(req, (err, fields, files) => {
      const host = fields.host;
      const username = fields.username;
      const password = mongo.decrypt(fields.password);
      const name = fields.name;
      const sourceOwner = fields.sourceOwner;
      const clientId = fields.clientId;
      const mode = fields.mode;
      let full = true;
      if (mode === 'update') {
        full = false;
      }
      dhis.sync(host, username, password, name, sourceOwner, clientId, topOrgId, topOrgName, false, full, false, false);
    });
  });

  app.post('/fhirSync', (req, res) => {
    res.status(200).end()
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      winston.info('Received a request to sync FHIR server ' + fields.host)
      fhir.sync(fields.host, fields.username, fields.password, fields.mode, fields.name, fields.sourceOwner, fields.clientId, topOrgId, topOrgName)
    })
  })

  app.get('/hierarchy', (req, res) => {
    let source = req.query.source
    let sourceOwner = req.query.sourceOwner
    let sourceLimitOrgId = req.query.sourceLimitOrgId
    let start = req.query.start
    let count = req.query.count
    let id = req.query.id
    if(!sourceLimitOrgId) {
      sourceLimitOrgId = topOrgId
    }
    if (!id) {
      id = sourceLimitOrgId
    }
    if (!source) {
      winston.error({
        error: 'Missing Source'
      });
      res.status(400).json({
        error: 'Missing Source'
      });
    } else {
      winston.info(`Fetching Locations For ${source}`);
      let db = source + sourceOwner
      var locationReceived = new Promise((resolve, reject) => {
        mcsd.getLocationChildren(db, sourceLimitOrgId, (mcsdData) => {
          mcsd.getBuildings(mcsdData, (buildings) => {
            resolve({
              buildings,
              mcsdData
            })
            winston.info(`Done Fetching ${source} Locations`);
          });
        })
      })

      locationReceived.then((data) => {
        winston.info(`Creating ${source} Grid`);
        mcsd.createGrid(id, sourceLimitOrgId, data.buildings, data.mcsdData, start, count, (grid, total) => {
          winston.info(`Done Creating ${source} Grid`);
          res.set('Access-Control-Allow-Origin', '*');
          res.status(200).json({
            grid,
            total
          });
        })
      }).catch((err) => {
        winston.error(err)
      })
    }
  });

  app.get('/getImmediateChildren/:source/:sourceOwner/:parentID?', (req, res) => {
    let source = req.params.source
    let sourceOwner = req.params.sourceOwner
    let parentID = req.params.parentID
    const db = source + sourceOwner
    if(!parentID) {
      parentID = topOrgId
    }
    winston.info("Received a request to get immediate children of " + parentID)
    let children = []
    mcsd.getImmediateChildren(db, parentID, (err, childrenData) => {
      async.each(childrenData.entry, (child, nxtChild) => {
        let isFacility = child.resource.physicalType.coding.find(coding => coding.code == 'bu')
        if(isFacility) {
          return nxtChild()
        }
        children.push({
          id: child.resource.id,
          name: child.resource.name,
          children: []
        })
        return nxtChild()
      }, () => {
        winston.info("Returning a list of children of " + parentID)
        res.status(200).json({
          children
        });
      })
    })
  })

  app.get('/getTree/:source/:sourceOwner/:sourceLimitOrgId?', (req, res) => {
    winston.info("Received a request to get location tree")
    if (!req.params.source) {
      winston.error({
        error: 'Missing Data Source',
      });
      res.status(400).json({
        error: 'Missing Data Source',
      });
    } else {
      const source = req.params.source
      let sourceOwner = req.params.sourceOwner
      let sourceLimitOrgId = req.params.sourceLimitOrgId
      let db = source + sourceOwner
      if(!sourceLimitOrgId) {
        sourceLimitOrgId = topOrgId
      }
      winston.info(`Fetching Locations For ${source}`);
      async.parallel({
        locationChildren(callback) {
          mcsd.getLocationChildren(db, sourceLimitOrgId, (mcsdData) => {
            winston.info(`Done Fetching Locations For ${source}`);
            return callback(false, mcsdData);
          });
        },
        parentDetails(callback) {
          if(sourceLimitOrgId === topOrgId) {
            return callback(false, false)
          }
          mcsd.getLocationByID(db, sourceLimitOrgId, false, (details) => {
            return callback(false, details)
          })
        }
      }, (error, response) => {
        winston.info(`Creating ${source} Tree`);
        mcsd.createTree(response.locationChildren, sourceLimitOrgId, (tree) => {
          if(sourceLimitOrgId !== topOrgId) {
            tree = {
              text: response.parentDetails.entry[0].resource.name,
              id: req.params.sourceLimitOrgId,
              children: tree
            }
          }
          winston.info(`Done Creating Tree for ${source}`);
          res.status(200).json(tree);
        });
      })
    }
  });

  app.get('/mappingStatus/:source1/:source2/:source1Owner/:source2Owner/:level/:totalSource2Levels/:totalSource1Levels/:clientId/:userID', (req, res) => {
    winston.info('Getting mapping status');
    const userID = req.params.userID
    const source1Owner = req.params.source1Owner
    const source2Owner = req.params.source2Owner
    let source1LimitOrgId = req.query.source1LimitOrgId
    let source2LimitOrgId = req.query.source2LimitOrgId
    if(!source1LimitOrgId) {
      source1LimitOrgId = topOrgId
    }
    if(!source2LimitOrgId) {
      source2LimitOrgId = topOrgId
    }
    const source1DB = req.params.source1 + source1Owner
    const source2DB = req.params.source2 + source2Owner
    const recoLevel = req.params.level;
    const totalSource2Levels = req.params.totalSource2Levels;
    const totalSource1Levels = req.params.totalSource1Levels;
    const clientId = req.params.clientId;

    let statusRequestId = `mappingStatus${clientId}`
    statusResData = JSON.stringify({
      status: '1/2 - Loading Source2 and Source1 Data',
      error: null,
      percent: null
    })
    redisClient.set(statusRequestId, statusResData)

    const source2LocationReceived = new Promise((resolve, reject) => {
      mcsd.getLocationChildren(source2DB, source2LimitOrgId, (mcsdSource2) => {
        mcsdSource2All = mcsdSource2;
        let level
        if (recoLevel === totalSource1Levels) {
          level = totalSource2Levels
        } else {
          level = recoLevel
        }
        if (levelMaps[source2DB] && levelMaps[source2DB][recoLevel]) {
          level = levelMaps[source2DB][recoLevel];
        }
        mcsd.filterLocations(mcsdSource2, source2LimitOrgId, level, (mcsdSource2Level) => {
          resolve(mcsdSource2Level);
        });
      });
    });
    const source1LocationReceived = new Promise((resolve, reject) => {
      mcsd.getLocationChildren(source1DB, source1LimitOrgId, (mcsdSource1) => {
        mcsd.filterLocations(mcsdSource1, source1LimitOrgId, recoLevel, (mcsdSource1Level) => {
          resolve(mcsdSource1Level);
        });
      });
    });
    const mappingDB = req.params.source1 + userID + req.params.source2
    const mappingLocationReceived = new Promise((resolve, reject) => {
      mcsd.getLocations(mappingDB, (mcsdMapped) => {
        resolve(mcsdMapped);
      });
    });
    Promise.all([source2LocationReceived, source1LocationReceived, mappingLocationReceived]).then((locations) => {
      var source2Locations = locations[0]
      var source1Locations = locations[1]
      var mappedLocations = locations[2]
      scores.getMappingStatus(source1Locations, source2Locations, mappedLocations, source1DB, clientId, (mappingStatus) => {
        res.status(200).json(mappingStatus)
      })
    })
  })

  app.get('/reconcile', (req, res) => {
    let totalSource1Levels = req.query.totalSource1Levels
    let totalSource2Levels = req.query.totalSource2Levels
    let recoLevel = req.query.recoLevel
    let clientId = req.query.clientId
    let userID = req.query.userID
    let source1 = req.query.source1
    let source2 = req.query.source2
    let source1Owner = req.query.source1Owner
    let source2Owner = req.query.source2Owner
    let source1LimitOrgId = req.query.source1LimitOrgId
    let source2LimitOrgId = req.query.source2LimitOrgId
    if(!source1LimitOrgId) {
      source1LimitOrgId = topOrgId
    }
    if(!source2LimitOrgId) {
      source2LimitOrgId = topOrgId
    }
    let parentConstraint
    try {
      parentConstraint = JSON.parse(req.query.parentConstraint)
    } catch (error) {
      parentConstraint = req.query.parentConstraint
    }
    if (!source1 || !source2 || !recoLevel || !userID) {
      winston.error({
        error: 'Missing source1 or source2 or reconciliation Level or userID'
      });
      res.status(400).json({
        error: 'Missing source1 or source2 or reconciliation Level or userID'
      });
    } else {
      winston.info('Getting scores');
      const orgid = req.query.orgid;
      let mcsdSource2All = null;
      let mcsdSource1All = null;

      let scoreRequestId = `scoreResults${clientId}`
      scoreResData = JSON.stringify({
        status: '1/3 - Loading Source2 and Source1 Data',
        error: null,
        percent: null
      })
      redisClient.set(scoreRequestId, scoreResData)
      async.parallel({
        source2Locations: function (callback) {
          let dbSource2 = source2 + source2Owner
          mcsd.getLocationChildren(dbSource2, source2LimitOrgId, (mcsdSource2) => {
            mcsdSource2All = mcsdSource2;
            let level
            if (recoLevel === totalSource1Levels) {
              level = totalSource2Levels
            } else {
              level = recoLevel
            }

            if (levelMaps[orgid] && levelMaps[orgid][recoLevel]) {
              level = levelMaps[orgid][recoLevel];
            }
            mcsd.filterLocations(mcsdSource2, source2LimitOrgId, level, (mcsdSource2Level) => {
              return callback(false, mcsdSource2Level)
            });
          });
        },
        source1Loations: function (callback) {
          let dbSource1 = source1 + source1Owner
          mcsd.getLocationChildren(dbSource1, source1LimitOrgId, (mcsdSource1) => {
            mcsdSource1All = mcsdSource1;
            mcsd.filterLocations(mcsdSource1, source1LimitOrgId, recoLevel, (mcsdSource1Level) => {
              return callback(false, mcsdSource1Level);
            });
          });
        },
        mappingData: function (callback) {
          const mappingDB = source1 + userID + source2
          mcsd.getLocations(mappingDB, (mcsdMapped) => {
            return callback(false, mcsdMapped);
          });
        }
      }, (error, results) => {
        let source1DB = source1 + source1Owner
        let source2DB = source2 + source2Owner
        let mappingDB = source1 + userID + source2
        if (recoLevel == totalSource1Levels) {
          scores.getBuildingsScores(
            results.source1Loations,
            results.source2Locations,
            results.mappingData,
            mcsdSource2All,
            mcsdSource1All,
            source1DB,
            source2DB,
            mappingDB,
            recoLevel,
            totalSource1Levels,
            clientId,
            parentConstraint, (scoreResults) => {
              recoStatus(source1, source2, userID, (totalAllMapped, totalAllNoMatch, totalAllIgnored, totalAllFlagged) => {
                scoreResData = JSON.stringify({
                  status: 'Done',
                  error: null,
                  percent: 100
                })
                redisClient.set(scoreRequestId, scoreResData)
                var source1TotalAllNotMapped = (mcsdSource1All.entry.length - 1) - totalAllMapped
                res.status(200).json({
                  scoreResults,
                  recoLevel,
                  source2TotalRecords: results.source2Locations.entry.length,
                  source2TotalAllRecords: mcsdSource2All.entry.length - 1,
                  totalAllMapped: totalAllMapped,
                  totalAllFlagged: totalAllFlagged,
                  totalAllNoMatch: totalAllNoMatch,
                  totalAllIgnored: totalAllIgnored,
                  source1TotalAllNotMapped: source1TotalAllNotMapped,
                  source1TotalAllRecords: mcsdSource1All.entry.length - 1
                });
                winston.info('Score results sent back');
              })
            });
        } else {
          scores.getJurisdictionScore(
            results.source1Loations,
            results.source2Locations,
            results.mappingData,
            mcsdSource2All,
            mcsdSource1All,
            source1DB,
            source2DB,
            mappingDB,
            recoLevel,
            totalSource1Levels,
            clientId,
            parentConstraint,
            (scoreResults) => {
              recoStatus(source1, source2, userID, (totalAllMapped, totalAllNoMatch, totalAllIgnored, totalAllFlagged) => {
                var source1TotalAllNotMapped = (mcsdSource1All.entry.length - 1) - totalAllMapped
                res.status(200).json({
                  scoreResults,
                  recoLevel,
                  source2TotalRecords: results.source2Locations.entry.length,
                  source2TotalAllRecords: mcsdSource2All.entry.length - 1,
                  totalAllMapped: totalAllMapped,
                  totalAllFlagged: totalAllFlagged,
                  totalAllNoMatch: totalAllNoMatch,
                  totalAllIgnored: totalAllIgnored,
                  source1TotalAllNotMapped: source1TotalAllNotMapped,
                  source1TotalAllRecords: mcsdSource1All.entry.length - 1
                });
                winston.info('Score results sent back');
              })
            });
        }
      })
    }

    function recoStatus(source1, source2, userID, callback) {
      //getting total Mapped
      var database = source1 + userID + source2;
      var totalAllMapped = 0
      var totalAllNoMatch = 0
      var totalAllIgnored = 0
      var totalAllFlagged = 0
      var source1TotalAllNotMapped = 0
      const noMatchCode = config.getConf('mapping:noMatchCode');
      const ignoreCode = config.getConf('mapping:ignoreCode');
      const flagCode = config.getConf('mapping:flagCode');
      setTimeout(() => {
        mcsd.getLocations(database, (body) => {
          if (!body.hasOwnProperty('entry') || body.length === 0) {
            totalAllNoMatch = 0
            totalAllIgnored = 0
            totalAllMapped = 0
            return callback(totalAllMapped, source1TotalAllNotMapped, totalAllNoMatch, totalAllIgnored, totalAllFlagged)
          }
          async.each(body.entry, (entry, nxtEntry) => {
            if (entry.resource.hasOwnProperty('tag')) {
              var nomatch = entry.resource.tag.find((tag) => {
                return tag.code === noMatchCode
              })
              var ignore = entry.resource.tag.find((tag) => {
                return tag.code === ignoreCode
              })
              var flagged = entry.resource.tag.find((tag) => {
                return tag.code === flagCode
              })
              if (nomatch) {
                totalAllNoMatch++
              }
              if (ignore) {
                totalAllIgnored++
              }
              if (flagged) {
                totalAllFlagged++
              }
              return nxtEntry()
            } else {
              return nxtEntry()
            }
          }, () => {
            totalAllMapped = body.entry.length - totalAllNoMatch - totalAllIgnored - totalAllFlagged
            return callback(totalAllMapped, totalAllNoMatch, totalAllIgnored, totalAllFlagged)
          })
        })
      }, 1000)
    }

  });
  app.get('/matchedLocations/:source1/:source2/:source1Owner/:source2Owner/:type/:userID', (req, res) => {
    winston.info(`Received a request to return matched Locations in ${req.params.type} format for ${req.params.source1}${req.params.source2}`);
    let userID = req.params.userID
    let source1Owner = req.params.source1Owner
    let source2Owner = req.params.source2Owner
    let source1DB = req.params.source1 + source1Owner
    let source2DB = req.params.source2 + source2Owner
    let mappingDB = req.params.source1 + userID + req.params.source2
    let type = req.params.type
    let matched = []

    const flagCode = config.getConf('mapping:flagCode');
    const flagCommentCode = config.getConf('mapping:flagCommentCode');
    const matchCommentsCode = config.getConf('mapping:matchCommentsCode');
    const noMatchCode = config.getConf('mapping:noMatchCode');
    const ignoreCode = config.getConf('mapping:ignoreCode');
    const autoMatchedCode = config.getConf('mapping:autoMatchedCode');
    const manualllyMatchedCode = config.getConf('mapping:manualllyMatchedCode');

    mcsd.getLocations(mappingDB, (mapped) => {
      if (type === 'FHIR') {
        winston.info('Sending back matched locations in FHIR specification')
        let mappedmCSD = {
          "resourceType": "Bundle",
          "type": "document",
          "entry": []
        }
        async.eachOf(mapped.entry, (entry, key, nxtEntry) => {
          if (entry.resource.hasOwnProperty('tag')) {
            noMatch = entry.resource.tag.find((tag) => {
              return tag.code == noMatchCode
            })
            ignore = entry.resource.tag.find((tag) => {
              return tag.code == ignoreCode
            })
            if (noMatch || ignore) {
              delete mapped.entry[key]
            }
            return nxtEntry()
          }
          return nxtEntry()
        }, () => {
          mappedmCSD.entry = mappedmCSD.entry.concat(mapped.entry)
          return res.status(200).json(mappedmCSD)
        })
      } else {
        let source1Fields = ['source 1 name', 'source 1 ID']
        let source2Fields = ['source 2 name', 'source 2 ID']
        let levelMapping1 = JSON.parse(req.query.levelMapping1)
        let levelMapping2 = JSON.parse(req.query.levelMapping2)
        async.each(mapped.entry, (entry, nxtmCSD) => {
          let status, flagged, noMatch, ignore, autoMatched, manuallyMatched, matchCommentsTag, flagCommentsTag
          if (entry.resource.hasOwnProperty('tag')) {
            flagged = entry.resource.tag.find((tag) => {
              return tag.code == flagCode
            })
            noMatch = entry.resource.tag.find((tag) => {
              return tag.code == noMatchCode
            })
            ignore = entry.resource.tag.find((tag) => {
              return tag.code == ignoreCode
            })
            autoMatched = entry.resource.tag.find((tag) => {
              return tag.code == autoMatchedCode
            })
            manuallyMatched = entry.resource.tag.find((tag) => {
              return tag.code == manualllyMatchedCode
            })
            matchCommentsTag = entry.resource.tag.find((tag) => {
              return tag.code == matchCommentsCode
            })
            flagCommentsTag = entry.resource.tag.find((tag) => {
              return tag.code == flagCommentCode
            })
          }
          if (noMatch || ignore) {
            return nxtmCSD()
          }
          let matchComments, flagComments, comment
          if (matchCommentsTag && matchCommentsTag.hasOwnProperty("display")) {
            comment = matchCommentsTag.display.join(', ')
          }
          if (flagCommentsTag && flagCommentsTag.hasOwnProperty("display")) {
            comment = flagCommentsTag.display
          }
          if (flagged) {
            status = 'Flagged'
          } else if (autoMatched) {
            status = "Automatically Matched"
          } else {
            status = "Manually Matched"
          }
          let source1ID = entry.resource.identifier.find((id) => {
            return id.system === 'https://digitalhealth.intrahealth.org/source1'
          })
          if (source1ID) {
            source1ID = source1ID.value.split('/').pop()
          } else {
            source1ID = ''
          }
          matched.push({
            'source 1 name': entry.resource.alias,
            'source 1 ID': source1ID,
            'source 2 name': entry.resource.name,
            'source 2 ID': entry.resource.id,
            'Status': status,
            'Comments': comment
          })
          return nxtmCSD()
        }, () => {
          async.parallel({
            source1mCSD: function (callback) {
              mcsd.getLocations(source1DB, (mcsd) => {
                return callback(null, mcsd)
              })
            },
            source2mCSD: function (callback) {
              mcsd.getLocations(source2DB, (mcsd) => {
                return callback(null, mcsd)
              })
            }
          }, (error, response) => {
            // remove unmapped levels
            let levels1 = Object.keys(levelMapping1)
            async.each(levels1, (level, nxtLevel) => {
              if (!levelMapping1[level] || levelMapping1[level] == 'null' || levelMapping1[level] == 'undefined' || levelMapping1[level] == 'false') {
                delete levelMapping1[level]
              }
            })

            let levels2 = Object.keys(levelMapping2)
            async.each(levels2, (level, nxtLevel) => {
              if (!levelMapping2[level] || levelMapping2[level] == 'null' || levelMapping2[level] == 'undefined' || levelMapping2[level] == 'false') {
                delete levelMapping2[level]
              }
            })
            // end of removing unmapped levels

            // get level of a facility
            let levelsArr1 = []
            async.eachOf(levelMapping1, (level, key, nxtLevel) => {
              if (key.startsWith('level')) {
                levelsArr1.push(parseInt(key.replace('level', '')))
              }
              return nxtLevel()
            })
            let source1FacilityLevel = levelsArr1.length + 1
            levelsArr1.push(source1FacilityLevel)

            let levelsArr2 = []
            async.eachOf(levelMapping2, (level, key, nxtLevel) => {
              if (key.startsWith('level')) {
                levelsArr2.push(parseInt(key.replace('level', '')))
              }
              return nxtLevel()
            })
            let source2FacilityLevel = levelsArr2.length + 1
            levelsArr2.push(source2FacilityLevel)
            // end of getting level of a facility

            let matchedCSV
            async.each(levelsArr1, (srcLevel, nxtLevel) => {
              // increment level by one, because level 1 is a fake country/location
              level = srcLevel + 1
              let thisFields = []
              let parentsFields1 = []
              let parentsFields2 = []
              thisFields = thisFields.concat(source1Fields)
              //push other headers
              async.eachOf(levelMapping1, (level, key, nxtLevel) => {
                if (!key.startsWith('level')) {
                  return nxtLevel()
                }
                let keyNum = key.replace('level', '')
                keyNum = parseInt(keyNum)
                if (keyNum >= srcLevel) {
                  return nxtLevel()
                }
                parentsFields1.push('Source1 ' + level)
                thisFields.push('Source1 ' + level)
              })

              thisFields = thisFields.concat(source2Fields)
              async.eachOf(levelMapping2, (level, key, nxtLevel) => {
                if (!key.startsWith('level')) {
                  return nxtLevel()
                }
                let keyNum = key.replace('level', '')
                keyNum = parseInt(keyNum)
                if (keyNum >= srcLevel) {
                  return nxtLevel()
                }
                parentsFields2.push('Source2 ' + level)
                thisFields.push('Source2 ' + level)
              })
              thisFields = thisFields.concat(["Status", "Comments"])
              //end of pushing other headers
              let levelMatched = []
              mcsd.filterLocations(response.source1mCSD, topOrgId, level, (mcsdLevel) => {
                async.each(mcsdLevel.entry, (source1Entry, nxtEntry) => {
                  let thisMatched = matched.filter((mapped) => {
                    return mapped["source 1 ID"] === source1Entry.resource.id
                  })

                  if (!thisMatched || thisMatched.length === 0) {
                    return nxtEntry()
                  }
                  let thisMatched1 = {}
                  let thisMatched2 = {}
                  // spliting content of thisMatched so that we can append source1 parents after source 1 data and source2 parents
                  // after source2 data
                  thisMatched1["source 1 ID"] = thisMatched[0]["source 1 ID"]
                  thisMatched1["source 1 name"] = thisMatched[0]["source 1 name"]
                  thisMatched2["source 2 ID"] = thisMatched[0]["source 2 ID"]
                  thisMatched2["source 2 name"] = thisMatched[0]["source 2 name"]
                  //end of splitting content of thisMatched

                  //getting parents
                  async.series({
                    source1Parents: function (callback) {
                      mcsd.getLocationParentsFromData(source1Entry.resource.id, response.source1mCSD, 'names', (parents) => {
                        parents = parents.slice(0, parents.length - 1)
                        parents.reverse()
                        async.eachOf(parentsFields1, (parent, key, nxtParnt) => {
                          thisMatched1[parent] = parents[key]
                          return nxtParnt()
                        }, () => {
                          return callback(null, thisMatched1)
                        })
                      })
                    },
                    source2Parents: function (callback) {
                      mcsd.getLocationParentsFromData(thisMatched[0]["source 2 ID"], response.source2mCSD, 'names', (parents) => {
                        parents = parents.slice(0, parents.length - 1)
                        parents.reverse()
                        async.eachOf(parentsFields2, (parent, key, nxtParnt) => {
                          thisMatched2[parent] = parents[key]
                          return nxtParnt()
                        }, () => {
                          thisMatched2["Status"] = thisMatched[0]["Status"]
                          thisMatched2["Comments"] = thisMatched[0]["Comments"]
                          return callback(null, thisMatched2)
                        })
                      })
                    }
                  }, (error, respo) => {
                    levelMatched.push(Object.assign(respo.source1Parents, respo.source2Parents))
                    return nxtEntry()
                  })
                }, () => {
                  if (levelMatched.length > 0) {
                    let csvString = json2csv(levelMatched, {
                      thisFields
                    });
                    let colHeader
                    if (levelMapping1['level' + srcLevel]) {
                      colHeader = levelMapping1['level' + srcLevel]
                    } else {
                      colHeader = "Facilities"
                    }
                    if (!matchedCSV) {
                      matchedCSV = colHeader + os.EOL + matchedCSV + csvString + os.EOL
                    } else {
                      matchedCSV = matchedCSV + os.EOL + os.EOL + colHeader + os.EOL + csvString + os.EOL
                    }
                  }
                  return nxtLevel()
                })
              })
            }, () => {
              res.status(200).send(matchedCSV)
            })
          })

        })
      }
    })

  })

  app.get('/unmatchedLocations/:source1/:source2/:source1Owner/:source2Owner/:type/:userID', (req, res) => {
    let userID = req.params.userID
    let source1Owner = req.params.source1Owner
    let source2Owner = req.params.source2Owner
    let source1DB = req.params.source1 + source1Owner
    let source2DB = req.params.source2 + source2Owner
    let levelMapping1 = JSON.parse(req.query.levelMapping1)
    let levelMapping2 = JSON.parse(req.query.levelMapping2)
    let type = req.params.type

    if (type == 'FHIR') {
      async.parallel({
        source1mCSD: function (callback) {
          mcsd.getLocations(source1DB, (mcsd) => {
            return callback(null, mcsd)
          })
        },
        source2mCSD: function (callback) {
          mcsd.getLocations(source2DB, (mcsd) => {
            return callback(null, mcsd)
          })
        }
      }, (error, response) => {
        let mappingDB = req.params.source1 + userID + req.params.source2
        async.parallel({
          source1Unmatched: function (callback) {
            scores.getUnmatched(response.source1mCSD, response.source1mCSD, mappingDB, true, 'source1', null, (unmatched, mcsdUnmatched) => {
              return callback(null, {
                unmatched,
                mcsdUnmatched
              })
            })
          },
          source2Unmatched: function (callback) {
            scores.getUnmatched(response.source2mCSD, response.source2mCSD, mappingDB, true, 'source2', null, (unmatched, mcsdUnmatched) => {
              return callback(null, {
                unmatched,
                mcsdUnmatched
              })
            })
          }
        }, (error, response) => {
          if (type === 'FHIR') {
            return res.status(200).json({
              unmatchedSource1mCSD: response.source1Unmatched.mcsdUnmatched,
              unmatchedSource2mCSD: response.source2Unmatched.mcsdUnmatched
            })
          }
        })
      })
    } else if (type == 'CSV') {
      let fields = []
      fields.push("id")
      fields.push("name")
      let levels = Object.keys(levelMapping1)
      let mappingDB = req.params.source1 + userID + req.params.source2

      async.parallel({
        source1mCSD: function (callback) {
          mcsd.getLocations(source1DB, (mcsd) => {
            return callback(null, mcsd)
          })
        },
        source2mCSD: function (callback) {
          mcsd.getLocations(source2DB, (mcsd) => {
            return callback(null, mcsd)
          })
        },
      }, (error, response) => {
        // remove unmapped levels
        async.each(levels, (level, nxtLevel) => {
          if (!levelMapping1[level] || levelMapping1[level] == 'null' || levelMapping1[level] == 'undefined' || levelMapping1[level] == 'false') {
            delete levelMapping1[level]
          }
          if (!levelMapping2[level] || levelMapping2[level] == 'null' || levelMapping2[level] == 'undefined' || levelMapping2[level] == 'false') {
            delete levelMapping2[level]
          }
        })
        // end of removing unmapped levels

        // get level of a facility
        let levelsArr1 = []
        async.eachOf(levelMapping1, (level, key, nxtLevel) => {
          if (key.startsWith('level')) {
            levelsArr1.push(parseInt(key.replace('level', '')))
          }
          return nxtLevel()
        })
        let source1FacilityLevel = levelsArr1.length + 1
        levelsArr1.push(source1FacilityLevel)

        let levelsArr2 = []
        async.eachOf(levelMapping2, (level, key, nxtLevel) => {
          if (key.startsWith('level')) {
            levelsArr2.push(parseInt(key.replace('level', '')))
          }
          return nxtLevel()
        })
        let source2FacilityLevel = levelsArr2.length + 1
        levelsArr2.push(source2FacilityLevel)
        // end of getting level of a facility

        let unmatchedSource1CSV, unmatchedSource2CSV
        async.parallel({
          source1: function (callback) {
            async.each(levelsArr1, (srcLevel, nxtLevel) => {
              // increment level by one, because level 1 is a fake country/location
              level = srcLevel + 1
              let thisFields = []
              let parentsFields = []
              thisFields = thisFields.concat(fields)
              async.eachOf(levelMapping1, (level, key, nxtLevel) => {
                if (!key.startsWith('level')) {
                  return nxtLevel()
                }
                let keyNum = key.replace('level', '')
                keyNum = parseInt(keyNum)
                if (keyNum >= srcLevel) {
                  return nxtLevel()
                }
                parentsFields.push(level)
                thisFields.push(level)
              })
              mcsd.filterLocations(response.source1mCSD, topOrgId, level, (mcsdLevel) => {
                scores.getUnmatched(response.source1mCSD, mcsdLevel, mappingDB, true, 'source1', parentsFields, (unmatched, mcsdUnmatched) => {
                  if (unmatched.length > 0) {
                    let csvString = json2csv(unmatched, {
                      thisFields
                    });
                    let colHeader
                    if (levelMapping1['level' + srcLevel]) {
                      colHeader = levelMapping1['level' + srcLevel]
                    } else {
                      colHeader = "Facilities"
                    }
                    if (!unmatchedSource1CSV) {
                      unmatchedSource1CSV = colHeader + os.EOL + unmatchedSource1CSV + csvString + os.EOL
                    } else {
                      unmatchedSource1CSV = unmatchedSource1CSV + os.EOL + os.EOL + colHeader + os.EOL + csvString + os.EOL
                    }
                  }
                  return nxtLevel()
                })
              })
            }, () => {
              return callback(false, unmatchedSource1CSV)
            })
          },
          source2: function (callback) {
            async.each(levelsArr2, (srcLevel, nxtLevel) => {
              // increment level by one, because level 1 is a fake country/location
              level = srcLevel + 1
              let thisFields = []
              let parentsFields = []
              thisFields = thisFields.concat(fields)
              async.eachOf(levelMapping2, (level, key, nxtLevel) => {
                if (!key.startsWith('level')) {
                  return nxtLevel()
                }
                let keyNum = key.replace('level', '')
                keyNum = parseInt(keyNum)
                if (keyNum >= srcLevel) {
                  return nxtLevel()
                }
                parentsFields.push(level)
                thisFields.push(level)
              })
              mcsd.filterLocations(response.source2mCSD, topOrgId, level, (mcsdLevel) => {
                scores.getUnmatched(response.source2mCSD, mcsdLevel, mappingDB, true, 'source2', parentsFields, (unmatched, mcsdUnmatched) => {
                  if (unmatched.length > 0) {
                    let csvString = json2csv(unmatched, {
                      thisFields
                    });
                    let colHeader
                    if (levelMapping2['level' + srcLevel]) {
                      colHeader = levelMapping2['level' + srcLevel]
                    } else {
                      colHeader = "Facilities"
                    }
                    if (!unmatchedSource2CSV) {
                      unmatchedSource2CSV = colHeader + os.EOL + unmatchedSource2CSV + csvString + os.EOL
                    } else {
                      unmatchedSource2CSV = unmatchedSource2CSV + os.EOL + os.EOL + colHeader + os.EOL + csvString + os.EOL
                    }
                  }
                  return nxtLevel()
                })
              })
            }, () => {
              return callback(false, unmatchedSource2CSV)
            })
          }
        }, (error, response) => {
          return res.status(200).send({
            unmatchedSource1CSV: response.source1,
            unmatchedSource2CSV: response.source2
          })
        })
      })
    }
  })

  app.get('/getUnmatched/:source1/:source2/:source1Owner/:source2Owner/:recoLevel/:userID', (req, res) => {
    winston.info(`Getting Source2 Unmatched Orgs for ${req.params.source1}`);
    if (!req.params.source1 || !req.params.source2) {
      winston.error({
        error: 'Missing Source1 or Source2'
      });
      res.status(400).json({
        error: 'Missing Source1 or Source2'
      });
      return;
    }
    let userID = req.params.userID
    let source1Owner = req.params.source1Owner
    let source2Owner = req.params.source2Owner
    let source2LimitOrgId = req.query.source2LimitOrgId
    if(!source2LimitOrgId) {
      source2LimitOrgId = topOrgId
    }
    let source2DB = req.params.source2 + source2Owner
    let mappingDB = req.params.source1 + userID + req.params.source2
    let recoLevel = req.params.recoLevel;
    if (levelMaps[source2DB] && levelMaps[source2D][recoLevel]) {
      recoLevel = levelMaps[orgid][recoLevel];
    }
    mcsd.getLocationChildren(source2DB, source2LimitOrgId, (mcsdAll) => {
      mcsd.filterLocations(mcsdAll, source2LimitOrgId, recoLevel, (mcsdLevel) => {
        scores.getUnmatched(mcsdAll, mcsdLevel, mappingDB, false, 'source2', null, (unmatched) => {
          winston.info(`sending back Source2 unmatched Orgs for ${req.params.source1}`);
          res.status(200).json(unmatched);
        });
      });
    });
  });

  app.post('/match/:type', (req, res) => {
    winston.info('Received data for matching');
    const type = req.params.type;
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      if (!fields.source1DB || !fields.source2DB) {
        winston.error({
          error: 'Missing Source1 or Source2'
        });
        res.status(400).json({
          error: 'Missing Source1 or Source2'
        });
        return;
      }
      let source1Id = fields.source1Id;
      const source2Id = fields.source2Id;
      const recoLevel = fields.recoLevel;
      const totalLevels = fields.totalLevels;
      const userID = fields.userID;
      const source1Owner = fields.source1Owner;
      const source2Owner = fields.source2Owner;
      let flagComment = fields.flagComment
      let source1DB = fields.source1DB + source1Owner
      let source2DB = fields.source2DB + source2Owner
      let mappingDB = fields.source1DB + userID + fields.source2DB
      if (!source1Id || !source2Id) {
        winston.error({
          error: 'Missing either Source1ID or Source2ID or both'
        });
        res.status(400).json({
          error: 'Missing either Source1ID or Source2ID or both'
        });
        return;
      }

      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${mappingDB}`
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${mappingDB}`
      }
      mongoose.connect(uri, {}, () => {
        models.MetaDataModel.findOne({}, (err, data) => {
          if (data.recoStatus === 'on-progress') {
            mcsd.saveMatch(source1Id, source2Id, source1DB, source2DB, mappingDB, recoLevel, totalLevels, type, false, flagComment, (err, matchComments) => {
              winston.info('Done matching');
              if (err) {
                winston.error(err)
                res.status(400).send({
                  error: err
                });
              } else {
                res.status(200).json({
                  matchComments: matchComments
                });
              }
            });
          } else {
            res.status(400).send({
              error: "Reconciliation closed"
            });
          }
        })
      })
    });
  });

  app.post('/acceptFlag/:source1/:source2/:userID', (req, res) => {
    winston.info('Received data for marking flag as a match');
    if (!req.params.source1 || !req.params.source2) {
      winston.error({
        error: 'Missing Source1 or Source2'
      });
      res.set('Access-Control-Allow-Origin', '*');
      res.status(400).json({
        error: 'Missing Source1 or Source2'
      });
      return;
    }
    const userID = req.params.userID;
    let mappingDB = req.params.source1 + userID + req.params.source2
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      const source2Id = fields.source2Id;
      if (!source2Id) {
        winston.error({
          error: 'Missing Source2ID'
        });
        res.set('Access-Control-Allow-Origin', '*');
        res.status(400).json({
          error: 'Missing Source2ID'
        });
        return;
      }

      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${mappingDB}`
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${mappingDB}`
      }
      mongoose.connect(uri, {}, () => {
        models.MetaDataModel.findOne({}, (err, data) => {
          if (data.recoStatus === 'on-progress') {
            mcsd.acceptFlag(source2Id, mappingDB, (err) => {
              winston.info('Done marking flag as a match');
              if (err) res.status(400).send({
                error: err
              });
              else res.status(200).send();
            });
          } else {
            res.status(400).send({
              error: "Reconciliation closed"
            });
          }
        })
      })
    });
  });

  app.post('/noMatch/:type/:source1/:source2/:source1Owner/:source2Owner/:userID', (req, res) => {
    winston.info('Received data for matching');
    if (!req.params.source1 || !req.params.source2) {
      winston.error({
        error: 'Missing Source1 or Source2'
      });
      res.set('Access-Control-Allow-Origin', '*');
      res.status(400).json({
        error: 'Missing Source1 or Source2'
      });
      return;
    }
    const userID = req.params.userID;
    const source1Owner = req.params.source1Owner;
    const source2Owner = req.params.source2Owner;
    const type = req.params.type;
    const source1DB = req.params.source1 + source1Owner;
    const source2DB = req.params.source2 + source2Owner;
    const mappingDB = req.params.source1 + userID + req.params.source2
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      let source1Id = fields.source1Id;
      const recoLevel = fields.recoLevel;
      const totalLevels = fields.totalLevels;
      if (!source1Id) {
        winston.error({
          error: 'Missing either Source1ID'
        });
        res.set('Access-Control-Allow-Origin', '*');
        res.status(400).json({
          error: 'Missing either Source1ID'
        });
        return;
      }

      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${mappingDB}`
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${mappingDB}`
      }
      mongoose.connect(uri, {}, () => {
        models.MetaDataModel.findOne({}, (err, data) => {
          if (data.recoStatus === 'on-progress') {
            mcsd.saveNoMatch(source1Id, source1DB, source2DB, mappingDB, recoLevel, totalLevels, type, (err) => {
              winston.info('Done matching');
              if (err) res.status(400).send({
                error: err
              });
              else res.status(200).send();
            });
          } else {
            res.status(400).send({
              error: "Reconciliation closed"
            });
          }
        })
      })
    });
  });

  app.post('/breakMatch/:source1/:source2/:source1Owner/:source2Owner/:userID', (req, res) => {
    if (!req.params.source1) {
      winston.error({
        error: 'Missing Source1'
      });
      res.status(400).json({
        error: 'Missing Source1'
      });
      return;
    }
    const userID = req.params.userID;
    const source1Owner = req.params.source1Owner;
    const source1DB = req.params.source1 + source1Owner;
    const mappingDB = req.params.source1 + userID + req.params.source2
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      winston.info(`Received break match request for ${fields.source2Id}`);
      const source2Id = fields.source2Id;

      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${mappingDB}`
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${mappingDB}`
      }
      mongoose.connect(uri, {}, () => {
        models.MetaDataModel.findOne({}, (err, data) => {
          if (data.recoStatus === 'on-progress') {
            mcsd.breakMatch(source2Id, mappingDB, source1DB, (err, results) => {
              winston.info(`break match done for ${fields.source2Id}`);
              res.status(200).send(err);
            });
          } else {
            res.status(400).send({
              error: "Reconciliation closed"
            });
          }
        })
      })
    });
  });

  app.post('/breakNoMatch/:type/:source1/:source2/:userID', (req, res) => {
    if (!req.params.source1 || !req.params.source2) {
      winston.error({
        error: 'Missing Source1'
      });
      res.set('Access-Control-Allow-Origin', '*');
      res.status(500).json({
        error: 'Missing Source1'
      });
      return;
    }
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      winston.info(`Received break no match request for ${fields.source1Id}`);
      var source1Id = fields.source1Id;
      if (!source1Id) {
        winston.error({
          'error': 'Missing Source1 ID'
        })
        res.set('Access-Control-Allow-Origin', '*');
        res.status(500).json({
          error: 'Missing Source1 ID'
        });
        return
      }
      const userID = req.params.userID;
      const type = req.params.type;
      const mappingDB = req.params.source1 + userID + req.params.source2

      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${mappingDB}`
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${mappingDB}`
      }
      mongoose.connect(uri, {}, () => {
        models.MetaDataModel.findOne({}, (err, data) => {
          if (data.recoStatus === 'on-progress') {
            mcsd.breakNoMatch(source1Id, mappingDB, (err) => {
              winston.info(`break no match done for ${fields.source1Id}`);
              res.set('Access-Control-Allow-Origin', '*');
              res.status(200).send(err);
            });
          } else {
            res.status(400).send({
              error: "Reconciliation closed"
            });
          }
        })
      })
    });
  });

  app.get('/markRecoUnDone/:source1/:source2/:userID', (req, res) => {
    winston.info(`received a request to mark reconciliation for ${req.params.userID} as undone`)

    const source1 = req.params.source1
    const source2 = req.params.source2
    const userID = req.params.userID
    const database = source1 + userID + source2

    if (mongoUser && mongoPasswd) {
      var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`
    } else {
      var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`
    }
    mongoose.connect(uri, {}, () => {
      models.MetaDataModel.findOne({}, (err, data) => {
        if (!data) {
          const MetaData = new models.MetaDataModel({
            recoStatus: "on-progress"
          });
          MetaData.save((err, data) => {
            if (err) {
              winston.error(err)
              winston.error("Failed to save reco status")
              res.status(500).json({
                error: 'Unexpected error occured,please retry'
              });
            } else {
              winston.info("Reco status saved successfully")
              res.status(200).json({
                status: 'on-progress'
              });
            }
          })
        } else {
          models.MetaDataModel.findByIdAndUpdate(data.id, {
            recoStatus: "on-progress"
          }, (err, data) => {
            if (err) {
              winston.error(err)
              winston.error("Failed to save reco status")
              res.status(500).json({
                error: 'Unexpected error occured,please retry'
              });
            } else {
              winston.info("Reco status saved successfully")
              res.status(200).json({
                status: 'on-progress'
              });
            }
          })
        }
      })
    })
  })

  app.get('/markRecoDone/:source1/:source2/:userID', (req, res) => {
    winston.info(`received a request to mark reconciliation for ${req.params.source1}${req.params.source2} as done`)

    const source1 = req.params.source1
    const source2 = req.params.source2
    const userID = req.params.userID
    const database = source1 + userID + source2

    const mongoose = require('mongoose')
    if (mongoUser && mongoPasswd) {
      var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
    } else {
      var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
    }
    mongoose.connect(uri, {}, () => {
      models.MetaDataModel.findOne({}, (err, data) => {
        if (!data) {
          const MetaData = new models.MetaDataModel({
            recoStatus: "Done"
          });
          MetaData.save((err, data) => {
            if (err) {
              winston.error(err)
              winston.error("Failed to save reco status")
              res.status(500).json({
                error: 'Unexpected error occured,please retry'
              });
            } else {
              winston.info("Reco status saved successfully")
              sendNotification((err, not) => {
                res.status(200).json({
                  status: 'Done'
                });
              })
            }
          })
        } else {
          models.MetaDataModel.findByIdAndUpdate(data.id, {
            recoStatus: "Done"
          }, (err, data) => {
            if (err) {
              winston.error(err)
              winston.error("Failed to save reco status")
              res.status(500).json({
                error: 'Unexpected error occured,please retry'
              });
            } else {
              winston.info("Reco status saved successfully")
              sendNotification((err, not) => {
                res.status(200).json({
                  status: 'Done'
                });
              })
            }
          })
        }
      })
    })

    function sendNotification(callback) {
      winston.info('received a request to send notification to endpoint regarding completion of reconciliation')
      let database = config.getConf("DB_NAME")
      if (mongoUser && mongoPasswd) {
        var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
      } else {
        var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
      }
      mongoose.connect(uri, {}, () => {
        models.MetaDataModel.findOne({}, {'config.generalConfig': 1}, (err, data) => {
          if (err) {
            winston.error(err)
            return callback(true, false)
          }
          if(!data) {
            return callback(false, false)
          }
          let configData = {}
          try {
            configData = JSON.parse(JSON.stringify(data))
          } catch (error) {
            winston.error(error)
            return callback(true, false)
          }

          if(configData.hasOwnProperty('config') &&
            configData.config.hasOwnProperty('generalConfig') &&
            configData.config.generalConfig.hasOwnProperty('recoProgressNotification') &&
            configData.config.generalConfig.recoProgressNotification.enabled &&
            configData.config.generalConfig.recoProgressNotification.url
          ) {
            let url = configData.config.generalConfig.recoProgressNotification.url
            let username = configData.config.generalConfig.recoProgressNotification.username
            let password = configData.config.generalConfig.recoProgressNotification.password
            var auth = "Basic " + new Buffer(username + ":" + password).toString("base64")
            const options = {
              url: url,
              headers: {
                Authorization: auth,
                'Content-Type': 'application/json'
              },
              json: {source1: source1, source2: source2, status: 'Done'},
            };
            request.post(options, (err, res, body) => {
              if (err) {
                winston.error(err);
                return callback(true, false)
              }
              return callback(false, body)
            });
          }
        })
      })
    }
  })

  app.get('/recoStatus/:source1/:source2/:userID', (req, res) => {
    const source1 = req.params.source1
    const source2 = req.params.source2
    const userID = req.params.userID
    const database = source1 + userID + source2
    if (mongoUser && mongoPasswd) {
      var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`
    } else {
      var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`
    }

    mongoose.connect(uri, {}, () => {
      models.MetaDataModel.findOne({}, (err, data) => {
        if (data && data.recoStatus) {
          res.status(200).json({
            status: data.recoStatus
          });
        } else {
          res.status(200).json({
            status: false
          });
        }
      })
    })
  })

  app.get('/progress/:type/:clientId', (req, res) => {
    const clientId = req.params.clientId;
    const type = req.params.type;
    const progressRequestId = `${type}${clientId}`;
    redisClient.get(progressRequestId, (error, results) => {
      results = JSON.parse(results);
      // reset progress
      if (results && (results.error !== null || results.status === 'Done')) {
        const uploadReqRes = JSON.stringify({
          status: null,
          error: null,
          percent: null,
        });
        redisClient.set(progressRequestId, uploadReqRes);
      }
      res.set('Access-Control-Allow-Origin', '*');
      res.status(200).json(results);
    });
  });

  app.get('/uploadProgress/:clientId', (req, res) => {
    const clientId = req.params.clientId
    redisClient.get(`uploadProgress${clientId}`, (error, results) => {
      results = JSON.parse(results)
      res.set('Access-Control-Allow-Origin', '*');
      res.status(200).json(results)
      //reset progress
      if (results && (results.error !== null || results.status === 'Done')) {
        var uploadRequestId = `uploadProgress${clientId}`
        let uploadReqPro = JSON.stringify({
          status: null,
          error: null,
          percent: null
        })
        redisClient.set(uploadRequestId, uploadReqPro)
      }
    })
  });

  app.get('/mappingStatusProgress/:clientId', (req, res) => {
    const clientId = req.params.clientId
    redisClient.get(`mappingStatus${clientId}`, (error, results) => {
      results = JSON.parse(results)
      res.status(200).json(results)
      //reset progress
      if (results && (results.error !== null || results.status === 'Done')) {
        var statusRequestId = `mappingStatus${clientId}`
        let statusResData = JSON.stringify({
          status: null,
          error: null,
          percent: null
        })
        redisClient.set(statusRequestId, statusResData)
      }
    })
  });

  app.get('/scoreProgress/:clientId', (req, res) => {
    const clientId = req.params.clientId
    redisClient.get(`scoreResults${clientId}`, (error, results) => {
      results = JSON.parse(results)
      res.status(200).json(results)
      //reset progress
      if (results && (results.error !== null || results.status === 'Done')) {
        const scoreRequestId = `scoreResults${clientId}`
        let uploadReqPro = JSON.stringify({
          status: null,
          error: null,
          percent: null
        })
        redisClient.set(scoreRequestId, uploadReqPro)
      }
    })
  });

  app.post('/addDataSource', (req, res) => {
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      winston.info('Received a request to add a new data source');
      mongo.addDataSource(fields, (err, response) => {
        if (err) {
          res.status(500).json({
            error: 'Unexpected error occured,please retry',
          });
          winston.error(err)
        } else {
          winston.info('Data source saved successfully');
          res.status(200).json({
            status: 'done',
            password: response
          });
        }
      });
    });
  });

  app.post('/editDataSource', (req, res) => {
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      winston.info('Received a request to edit a data source');
      mongo.editDataSource(fields, (err, response) => {
        if (err) {
          res.set('Access-Control-Allow-Origin', '*');
          res.status(500).json({
            error: 'Unexpected error occured,please retry',
          });
          winston.error(err)
        } else {
          winston.info('Data source edited sucessfully');
          res.set('Access-Control-Allow-Origin', '*');
          res.status(200).json({
            status: 'done',
            password: response
          });
        }
      });
    });
  });

  app.get('/deleteDataSource/:_id/:name/:sourceOwner/:userID', (req, res) => {
    const id = req.params._id;
    let sourceOwner = req.params.sourceOwner
    let userID = req.params.userID
    const name = mixin.toTitleCase(req.params.name)
    winston.info('Received request to delete data source with id ' + id)
    mongo.deleteDataSource(id, name, sourceOwner, userID, (err, response) => {
      if (err) {
        res.status(500).json({
          error: 'Unexpected error occured while deleting data source,please retry',
        });
        winston.error(err)
      } else {
        res.status(200).json({
          status: 'done',
        });
      }
    });
  });

  app.get('/getDataSources/:userID', (req, res) => {
    winston.info('received request to get data sources');
    mongo.getDataSources(req.params.userID, (err, servers) => {
      if (err) {
        res.status(500).json({
          error: 'Unexpected error occured,please retry',
        });
        winston.error(err)
      } else {
        getLastUpdateTime(servers, (servers) => {
          if (err) {
            winston.error(err)
            winston.error("An error has occured while getting data source")
            res.status(500).send("An error has occured while getting data source")
            return
          }
          winston.info('returning list of data sources ' + JSON.stringify(servers))
          res.status(200).json({
            servers,
          })
        })
      }
    })
  })

  app.get('/getDataPairs/:userID', (req, res) => {
    winston.info('received request to get data sources');
    mongo.getDataPairs(req.params.userID, (err, pairs) => {
      if (err) {
        res.status(500).json({
          error: 'Unexpected error occured,please retry',
        });
        winston.error(err)
      } else {
        res.status(200).json(pairs)
      }
    })
  })

  app.post('/addDataSourcePair', (req, res) => {
    winston.info('Received a request to save data source pairs')
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      mongo.addDataSourcePair(fields, (error, results) => {
        if (error) {
          winston.error(error)
          res.status(400).json({
            error: 'Unexpected error occured while saving'
          })
        } else {
          let db1 = mixin.toTitleCase(JSON.parse(fields.source1).name) + JSON.parse(fields.source1).userID._id
          let db2 = mixin.toTitleCase(JSON.parse(fields.source2).name) + JSON.parse(fields.source2).userID._id
          async.series({
            levelMapping1: function (callback) {
              mongo.getLevelMapping(db1, (levelMapping) => {
                return callback(false, levelMapping)
              })
            },
            levelMapping2: function (callback) {
              mongo.getLevelMapping(db2, (levelMapping) => {
                return callback(false, levelMapping)
              })
            }
          }, (err, mappings) => {
            winston.info('Data source pair saved successfully')
            res.status(200).json(JSON.stringify(mappings))
          })
        }
      })
    })
  })

  app.post('/activateSharedPair', (req, res) => {
    winston.info('Received a request to activate shared data source pair')
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      mongo.activateSharedPair(fields.pairID, fields.userID, (error, results) => {
        if (error) {
          winston.error(error)
          res.status(400).json({
            error: 'Unexpected error occured while activating shared data source pair'
          })
        } else {
          winston.info('Shared data source pair activated successfully')
          res.status(200).send()
        }
      })
    })
  })

  app.get('/resetDataSourcePair/:userID', (req, res) => {
    winston.info('Received a request to reset data source pair')
    mongo.resetDataSourcePair(req.params.userID, (error, response) => {
      if (error) {
        winston.error(error)
        res.status(400).json({
          error: 'Unexpected error occured while saving'
        })
      } else {
        winston.info('Data source pair reseted successfully')
        res.status(200).send()
      }
    })
  })

  app.get('/getDataSourcePair/:userID', (req, res) => {
    winston.info("Received a request to get data source pair")
    mongo.getDataSourcePair(req.params.userID, (err, sources) => {
      if (err) {
        winston.error('Unexpected error occured while getting data source pairs')
        winston.error(err)
        res.status(400).json({
          error: 'Unexpected error occured while getting data source pairs'
        })
      } else {
        winston.info("Returning list of data source pairs")
        res.status(200).json(sources)
      }
    })
  })

  app.get('/getUploadedCSV/:sourceOwner/:name', (req, res) => {
    let sourceOwner = req.params.sourceOwner
    let name = mixin.toTitleCase(req.params.name)
    const filter = function (stat, path) {
      if (path.includes(`${sourceOwner}+${name}+`)) {
        return true;
      } else {
        return false;
      }
    };
    let filePath, timeStamp0
    const files = fsFinder.from(`${__dirname}/csvUploads/`).filter(filter).findFiles((files) => {
      async.eachSeries(files, (file, nxtFile) => {
        timeStamp1 = file.split('/').pop().replace('.csv', '').replace(`${sourceOwner}_${name}_`, '');
        if (!timeStamp0) {
          timeStamp0 = timeStamp1
          filePath = file
        } else {
          if (moment(timeStamp1).isAfter(timeStamp0)) {
            timeStamp0 = timeStamp1
            filePath = file
          }
        }
        return nxtFile();
      }, () => {
        if (filePath) {
          fs.readFile(filePath, function (err, data) {
            res.status(200).send(data)
          })
        } else {
          res.status(404).send("CSV file not found")
        }
      });
    });
  })
  app.post('/uploadCSV', (req, res) => {
    const form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      winston.info(`Received Source1 Data with fields Mapping ${JSON.stringify(fields)}`);
      if (!fields.csvName) {
        winston.error({
          error: 'Missing CSV Name'
        });
        res.set('Access-Control-Allow-Origin', '*');
        res.status(400).json({
          error: 'Missing CSV Name'
        });
        return;
      }
      const database = mixin.toTitleCase(fields.csvName) + fields.userID;
      const expectedLevels = config.getConf('levels');
      const clientId = fields.clientId
      var uploadRequestId = `uploadProgress${clientId}`
      let uploadReqPro = JSON.stringify({
        status: 'Request received by server',
        error: null,
        percent: null
      })
      redisClient.set(uploadRequestId, uploadReqPro)
      if (!Array.isArray(expectedLevels)) {
        winston.error('Invalid config data for key Levels ');
        res.set('Access-Control-Allow-Origin', '*');
        res.status(400).json({
          error: 'Un expected error occured while processing this request'
        });
        res.end();
        return;
      }
      if (Object.keys(files).length == 0) {
        winston.error('No file submitted for reconciliation');
        res.status(400).json({
          error: 'Please submit CSV file for facility reconciliation'
        });
        res.end();
        return;
      }
      const fileName = Object.keys(files)[0];
      winston.info('validating CSV File');
      uploadReqPro = JSON.stringify({
        status: '2/3 Validating CSV Data',
        error: null,
        percent: null
      })
      redisClient.set(uploadRequestId, uploadReqPro)
      validateCSV(files[fileName].path, fields, (valid, invalid) => {
        if (invalid.length > 0) {
          winston.error("Uploaded CSV is invalid (has either duplicated IDs or empty levels/facility),execution stopped");
          res.status(400).json({
            error: invalid
          });
          res.end();
          return;
        } else {
          res.status(200).end();
        }
        let oldPath = files[fileName].path

        let newPath = `${__dirname}/csvUploads/${fields.userID}+${mixin.toTitleCase(fields.csvName)}+${moment().format()}.csv`
        fs.readFile(oldPath, function (err, data) {
          if (err) {
            winston.error(err)
          }
          fs.writeFile(newPath, data, function (err) {
            if (err) {
              winston.error(err)
            }
          });
        });
        winston.info('CSV File Passed Validation');
        winston.info(`Uploading data for ${database} now`)
        let uploadReqPro = JSON.stringify({
          status: '3/3 Uploading of DB started',
          error: null,
          percent: null
        })
        redisClient.set(uploadRequestId, uploadReqPro)
        mongo.saveLevelMapping(fields, database, (error, response) => {

        })
        mcsd.CSVTomCSD(files[fileName].path, fields, database, clientId, () => {
          winston.info(`Data upload for ${database} is done`)
          let uploadReqPro = JSON.stringify({
            status: 'Done',
            error: null,
            percent: 100
          })
          redisClient.set(uploadRequestId, uploadReqPro)
        });
      });
    });

    function validateCSV(filePath, headerMapping, callback) {
      let invalid = []
      let ids = []
      const levels = config.getConf('levels');
      levels.sort();
      levels.reverse();
      csv
        .fromPath(filePath, {
          headers: true,
        })
        .on('data', (data) => {
          let rowMarkedInvalid = false
          let index = 0
          async.eachSeries(levels, (level, nxtLevel) => {
            if (headerMapping[level] === null ||
              headerMapping[level] === 'null' ||
              headerMapping[level] === undefined ||
              !headerMapping[level]) {
              return nxtLevel()
            }
            if (index === 0) {
              index++
              if (ids.length == 0) {
                ids.push(data[headerMapping.code])
              } else {
                let idExist = ids.find((id) => {
                  return id === data[headerMapping.code]
                })
                if (idExist) {
                  rowMarkedInvalid = true
                  let reason = 'Duplicate ID'
                  populateData(headerMapping, data, reason, invalid)
                } else {
                  ids.push(data[headerMapping.code])
                }
              }
            }
            if (!rowMarkedInvalid) {
              if (data[headerMapping[level]] === null ||
                data[headerMapping[level]] === undefined ||
                data[headerMapping[level]] === false ||
                !data[headerMapping[level]] ||
                data[headerMapping[level]] === '' ||
                !isNaN(headerMapping[level]) ||
                data[headerMapping[level]] == 0) {
                let reason = headerMapping[level] + ' is blank'
                populateData(headerMapping, data, reason, invalid)
              } else {
                return nxtLevel()
              }
            }
          }, () => {
            if (data[headerMapping.facility] === null ||
              data[headerMapping.facility] === undefined ||
              data[headerMapping.facility] === false ||
              data[headerMapping.facility] === '' ||
              data[headerMapping.facility] == 0) {
              let reason = headerMapping.facility + ' is blank'
              populateData(headerMapping, data, reason, invalid)

            }
          })
        })
        .on('end', () => {
          return callback(true, invalid);
        })

      function populateData(headerMapping, data, reason, invalid) {
        let row = {}
        async.each(headerMapping, (header, nxtHeader) => {
          if (header == 'null') {
            return nxtHeader()
          }
          if (!data.hasOwnProperty(header)) {
            return nxtHeader()
          }
          row[header] = data[header]
          return nxtHeader()
        }, () => {
          invalid.push({
            data: row,
            reason
          })
        })
      }
    }
  });

  //merging signup custom fields into Users model
  let database = config.getConf("DB_NAME")
  if (mongoUser && mongoPasswd) {
    var uri = `mongodb://${mongoUser}:${mongoPasswd}@${mongoHost}:${mongoPort}/${database}`;
  } else {
    var uri = `mongodb://${mongoHost}:${mongoPort}/${database}`;
  }
  mongoose.connect(uri, {}, () => {
    models.MetaDataModel.find({
      "forms.name": "signup"
    }, (err, data) => {
      let Users
      if (data && data.length > 0) {
        let signupFields = Object.assign({}, data[0].forms[0].fields)
        signupFields = Object.assign(signupFields, models.usersFields)
        Users = new mongoose.Schema(signupFields)
      } else {
        Users = new mongoose.Schema(models.usersFields)
      }
      delete mongoose.connection.models['Users']
      models.UsersModel = mongoose.model('Users', Users)
    })
  })

  app.get('/gofr', function (req, res) {
    res.sendFile(path.join(__dirname + '/../gui/index.html'));
  });
  app.get('/static/js/:file', function (req, res) {
    res.sendFile(path.join(__dirname + '/../gui/static/js/' + req.params.file));
  });
  app.get('/static/css/:file', function (req, res) {
    res.sendFile(path.join(__dirname + '/../gui/static/css/' + req.params.file));
  });
  app.get('/static/img/:file', function (req, res) {
    res.sendFile(path.join(__dirname + '/../gui/static/img/' + req.params.file));
  });

  server.listen(config.getConf('server:port'));
  winston.info(`Server is running and listening on port ${config.getConf('server:port')}`);
}