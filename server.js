var express = require('express');
const config = require('./config/common.json');
const request = require('request');
const http = require('http');

var app = express();

app.use(express.static('public'));

var reloadverdi = 10000;
var newTempValues = reloadverdi * 30;
var reloadIn = 0;

var port = config.port;
var ip = config.ip;

var fs = require('fs');
var util = require('util');
var oppstartstidspunkt = new Date();

// Kolon er ugyldig i filnavn på Windows. 2026-11-12T10:51:41.054Z -> 2026-11-12T10-51-41.054Z
var log_file = fs.createWriteStream(__dirname + '/logging' + oppstartstidspunkt.toISOString().replace(/:/g, '-') + '.log', {flags : 'w'});
log_file.on('error', function (err) {
	process.stdout.write('Kunne ikke skrive loggfil: ' + err.message + '\n');
});
var log_stdout = process.stdout;


app.set('view engine', 'ejs');

var temperaturer = [];

var sensorverdier = [];
var devices = [];
var lastStableTemp = null;
var lastStableHum = null;
var pendingTemp = null;
var pendingCount = 0;
var TEMP_JUMP = 2;
var TEMP_CONFIRM = 3;

var darkmode = "on";

// Fetching all devices from Telldus, updating devices-array
getDevices()

//var authorization = "Bearer " + config.authkey;
//logging("Authorization : " + authorization)

function getDevices(){
    (async () => {
    request({
	url: "http://" + config.ip + "/api/sensors/list",
	method: "GET",
	headers: {
	    "User-Agent": "sensors",
	    "Authorization": "Bearer " + config.authkey,
	    "Content-Type": "application/json",
	    "Accept": "application/json"
	  }
    }, (err, rs, body) => {
	try
	{
        	var values = JSON.parse(body);
        	//logging("Sensorverdier hentet ut:" + JSON.stringify(values));
        	devices = values.sensor;
        	//logging("Hentet ut devices!")
        } catch (e) {
		console.log('invalid json: ' + body);
        }
    });
    })();

}

function pad (length, str) {
    str = str.toString();
      return str.length < length ? pad("0" + str, length) : str;
}

function dataValue(data, name, fallbackIndex) {
	if (!data) {
		return undefined;
	}
	for (var i = 0; i < data.length; i++) {
		if (data[i] && data[i].name === name) {
			return data[i].value;
		}
	}
	return data[fallbackIndex] ? data[fallbackIndex].value : undefined;
}

// A 433 MHz packet sometimes decodes as one wild sample (2.5, 2.5, 21.7, 2.5).
// Keep the last accepted temperature unless the new level repeats.
function trackTemp(raw) {
	var value = Number(raw);
	if (!isFinite(value)) {
		return null;
	}
	if (lastStableTemp !== null && Math.abs(value - lastStableTemp) <= TEMP_JUMP) {
		lastStableTemp = value;
		pendingTemp = null;
		pendingCount = 0;
		return lastStableTemp;
	}
	if (pendingTemp !== null && Math.abs(value - pendingTemp) <= 0.5) {
		pendingCount++;
	} else {
		pendingTemp = value;
		pendingCount = 1;
	}
	if (pendingCount >= TEMP_CONFIRM) {
		lastStableTemp = value;
		pendingTemp = null;
		pendingCount = 0;
		return lastStableTemp;
	}
	if (lastStableTemp !== null) {
		logging("Ignorerer hopp i temperatur: " + value + " (bruker " + lastStableTemp + ")");
	}
	return lastStableTemp;
}

function updateAllTemp(){
    var currentDate = new Date();
    getDevices()
    //logging("Oppdaterer temperaturer for følgende antall enheter: " +  devices.length);

    devices.forEach((element, index) => {
        (async () => {
            request({
		url: "http://" + config.ip + "/api/sensor/info?id=" + element.id,
		method: "GET",
		headers: {
		    "User-Agent": "sensors",
		    "Authorization": "Bearer " + config.authkey,
		    "Content-Type": "application/json",
		    "Accept": "application/json"
		}
            }, (err, rs, body) => {
            	try {
                	var values = JSON.parse(body);
                    	//logging("Hentet ut data");
                    	//logging("Full metering data:" + JSON.stringify(values));
                    	//logging("1: ReloadIn: " + reloadIn);
		    	if(values.data != undefined && values.data[0] !=undefined)
			{
				logging("Enhet nr: " + index + ", har verdi:" + values.data[0].value)
			} else
			{
				logging("Emhet nr: " + index + ", data undefined....")
			}
                    	sensorverdier[index] = values;
                    	if (values.model == config.outdoor) {
				var rawTemp = dataValue(values.data, "temp", 0);
				var rawHum = dataValue(values.data, "humidity", 1);
				var stableTemp = trackTemp(rawTemp);
				if (stableTemp !== null && Math.abs(Number(rawTemp) - stableTemp) <= TEMP_JUMP) {
					lastStableHum = rawHum;
				}
				if(reloadIn <= 0){
					if (stableTemp === null) {
						logging("Venter på stabil temperatur, råverdi: " + rawTemp);
					} else {
						reloadIn = newTempValues;
						logging("Funnet " + config.outdoor + ", legger til i grafarray")
						if (temperaturer.length > 479) {
							temperaturer.shift();
						}
						var tempArray = [];
						tempArray[0] = stableTemp;
						tempArray[1] = currentDate.getHours() + ":" + ('00' + currentDate.getMinutes()).slice(-2);
						tempArray[2] = lastStableHum != null ? lastStableHum : rawHum;
						tempArray[3] = currentDate.getDate() + "/" + (currentDate.getMonth() + 1);
						temperaturer.push(tempArray);
						logging("ID for sensor:" + values.id);
						logging("Values for sensor:" + tempArray[0] + ", " + tempArray[2]);
						logging("Time for value:" + tempArray[1]);
						logging("Length of array:" + temperaturer.length);
					}
				} else {
					reloadIn = reloadIn - reloadverdi;
				}
                	    	//logging("2: ReloadIn: " + reloadIn);
	                }
       	        } catch (e) {
			console.log('invalid json: ' + body);
	            	// updateTempLocal();
               	}
            });
        })();
    });
}


app.get('/mode/:mode', function (req, res) {
    if (req.params.mode != null) {
        if (req.params.mode == "1") {
            logging("Changing to nightmode")
            darkmode = "on";
            res.redirect('/')
        } else if (req.params.mode == "daymode") {
            logging("Changing to daymode")
            darkmode = "off";
            res.redirect('/')
        } else if (req.params.mode == "reload") {
            logging("Reloading, running normal get")
            res.redirect('/')
        } else {
            logging("NO action , not reloading")
            res.redirect('/')
        }
    }
})

app.get('/temperaturer', (req, res) => {
	const data = [];
	for (let i = 0; i < temperaturer.length; i++) {
	  var element = {};
	  element.temp = temperaturer[i][0];
	  element.time = temperaturer[i][1];
	  element.hum = temperaturer[i][2];
	  element.date = temperaturer[i][3];
	  data.push(element);
	}
	//data = [{ "temp": "22.5", "time": "18:10" },{"temp":"22.4", "time":"18:15"}]; // Example
  	res.json(data);
});

app.get('/', function (req, res) {
	res.render('index',
	{
		    darkmode
       	})
})

setInterval(function(){
    updateAllTemp();
}, reloadverdi);


var server = app.listen(port, function () {
    logging( "Server started, listening at port: " + port)
})


//Method for using the local API
function updateTempLocal(){
    var currentDate = new Date();
    var auth = "Bearer " + config.localauthkey;
    logging("(LOCAL) Oppdaterer temperaturer for følgende antall enheter: " +  devices.length);

    devices.forEach((element, index) => {
        var url = "http://192.168.1.253/api/sensor/info?id=" + element.id;
        (async () => {
            http.get(url, {headers: {"Authorization": auth}}, (resp) => {
                let data = '';

                // A chunk of data has been received.
                resp.on('data', (chunk) => {
                    data += chunk;
                });
                // The whole response has been received. Print out the result.
                resp.on('end', () => {
                    var values = JSON.parse(data);
                    if (sensorverdier.length > 479) {
                        sensorverdier.shift();
                    }
                    sensorverdier[index] = values;
                    if (values.name == config.outdoor) {
                        logging("Funnet " + config.outdoor + ", legger til i grafarray")
                        if (temperaturer.length > 479) {
                            temperaturer.shift();
                        } else if (values != null && values.data != undefined) {
                            var tempArray = [];
                            tempArray[0] = values.data[0].value;
                            tempArray[1] = currentDate.getHours() + ":" + pad(2, currentDate.getMinutes());
                            tempArray[2] = values.data[1].value;
                            temperaturer.push(tempArray);
                            logging("ID for sensor:" + values.id);
                            logging("Value for sensor:" + tempArray[0]);
                            logging("Date for value:" + tempArray[1]);
                            logging("Lengt of array:" + temperaturer.length);
                            logging("Full metering data:" + JSON.stringify(values));
                        } else {
                            var tempArray = [];
                            tempArray[0] = "N/A";
                            tempArray[1] = currentDate.getHours() + ":" + pad(2, currentDate.getMinutes());
                            temperaturer.push(tempArray);
                        }
                    }
                });
            }).on("error", (err) => {
                console.log("Error: " + err.message);
            });
        })();
    });
}

function logging(logtext)
{
        //const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'};
        let d = port + ":" + new Date().toISOString() + " : " + logtext;
        log_file.write(util.format(d) + '\n');
        log_stdout.write(util.format(d) + '\n');
}

process.on('uncaughtException', err => {
	logging('Noe uventet feil har skjedd:' + err.message);
	logging('Noe uventet feil har skjedd:' + err.stack);
	process.exit(1)
})

process.on('SIGINT', () => {
	logging('Ctrl + C, stopper prosess');
	process.exit(0)
})

process.on('SIGTERM', () => {
	logging('Prosess terminert....');
	process.exit(0)
})



//function logging(logtext)
//{
//    console.log(port + ":" + new Date().toISOString() + " : " + logtext);
//}
