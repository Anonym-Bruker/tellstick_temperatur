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

var sensorverdier = [];
var devices = [];
var sensorHistories = {};
var sensorState = {};
var sensorOrder = [];
var currentSensor = 0;
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

function ensureSensor(id) {
	id = String(id);
	if (!sensorState[id]) {
		sensorState[id] = {
			id: id,
			lastStableTemp: null,
			lastStableHum: null,
			pendingTemp: null,
			pendingCount: 0,
			name: "",
			model: ""
		};
	}
	if (!sensorHistories[id]) {
		sensorHistories[id] = [];
	}
	return sensorState[id];
}

function labelForSensor(id) {
	var state = sensorState[String(id)];
	if (state && state.name && String(state.name).trim() !== "") {
		return String(state.name);
	}
	return "Sensor " + id;
}

function syncSensorOrder() {
	var next = [];
	var seen = {};
	for (var i = 0; i < devices.length; i++) {
		var id = String(devices[i].id);
		if (sensorState[id] && !seen[id]) {
			next.push(id);
			seen[id] = true;
		}
	}
	for (var knownId in sensorState) {
		if (!seen[knownId]) {
			next.push(knownId);
			seen[knownId] = true;
		}
	}
	sensorOrder = next;
	if (sensorOrder.length === 0) {
		currentSensor = 0;
		return;
	}
	if (currentSensor < 0 || currentSensor >= sensorOrder.length) {
		currentSensor = 0;
	}
}

function stepSensor(delta) {
	syncSensorOrder();
	if (sensorOrder.length === 0) {
		return;
	}
	currentSensor = (currentSensor + delta) % sensorOrder.length;
	if (currentSensor < 0) {
		currentSensor += sensorOrder.length;
	}
	logging("Bytter til " + labelForSensor(sensorOrder[currentSensor]));
}

function sensorView() {
	syncSensorOrder();
	var count = sensorOrder.length;
	var position = 0;
	var label = "No sensor";
	if (count > 0) {
		position = currentSensor + 1;
		label = labelForSensor(sensorOrder[currentSensor]);
	}
	return {
		darkmode: darkmode,
		sensorLabel: label,
		sensorPosition: position,
		sensorCount: count
	};
}

function pushHistory(id, temp, hum, currentDate) {
	var history = sensorHistories[String(id)];
	if (!history) {
		history = [];
		sensorHistories[String(id)] = history;
	}
	if (history.length > 479) {
		history.shift();
	}
	var tempArray = [];
	tempArray[0] = temp;
	tempArray[1] = currentDate.getHours() + ":" + ('00' + currentDate.getMinutes()).slice(-2);
	tempArray[2] = hum != null ? hum : null;
	tempArray[3] = currentDate.getDate() + "/" + (currentDate.getMonth() + 1);
	history.push(tempArray);
	logging("ID for sensor:" + id);
	logging("Values for sensor:" + tempArray[0] + ", " + tempArray[2]);
	logging("Time for value:" + tempArray[1]);
	logging("Length of array:" + history.length);
}

function currentSeries() {
	if (sensorOrder.length === 0) {
		return [];
	}
	syncSensorOrder();
	return sensorHistories[sensorOrder[currentSensor]] || [];
}

// A 433 MHz packet sometimes decodes as one wild sample (2.5, 2.5, 21.7, 2.5).
// Each sensor keeps its own last accepted temperature unless the new level repeats.
function trackTemp(state, raw) {
	var value = Number(raw);
	if (!isFinite(value)) {
		return null;
	}
	if (state.lastStableTemp !== null && Math.abs(value - state.lastStableTemp) <= TEMP_JUMP) {
		state.lastStableTemp = value;
		state.pendingTemp = null;
		state.pendingCount = 0;
		return state.lastStableTemp;
	}
	if (state.pendingTemp !== null && Math.abs(value - state.pendingTemp) <= 0.5) {
		state.pendingCount++;
	} else {
		state.pendingTemp = value;
		state.pendingCount = 1;
	}
	if (state.pendingCount >= TEMP_CONFIRM) {
		state.lastStableTemp = value;
		state.pendingTemp = null;
		state.pendingCount = 0;
		return state.lastStableTemp;
	}
	if (state.lastStableTemp !== null) {
		logging("Ignorerer hopp i temperatur for " + state.id + ": " + value + " (bruker " + state.lastStableTemp + ")");
	}
	return state.lastStableTemp;
}

function updateAllTemp(){
    var currentDate = new Date();
    var dueForSample = reloadIn <= 0;
    if (!dueForSample) {
        reloadIn = reloadIn - reloadverdi;
    }
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
                    	logging("Full metering data:" + JSON.stringify(values));
                    	//logging("1: ReloadIn: " + reloadIn);
		    	if(values.data != undefined && values.data[0] !=undefined)
			{
				logging("Enhet nr: " + index + ", har verdi:" + values.data[0].value)
			} else
			{
				logging("Emhet nr: " + index + ", data undefined....")
			}
			sensorverdier[index] = values;
			var rawTemp = dataValue(values.data, "temp", 0);
			if (rawTemp === undefined) {
				return;
			}
			var id = String(values.id != null ? values.id : element.id);
			var state = ensureSensor(id);
			state.name = values.name || "";
			state.model = values.model || "";
			syncSensorOrder();
			var rawHum = dataValue(values.data, "humidity", 1);
			var stableTemp = trackTemp(state, rawTemp);
			if (stableTemp !== null && Math.abs(Number(rawTemp) - stableTemp) <= TEMP_JUMP) {
				state.lastStableHum = rawHum;
			}
			var history = sensorHistories[id];
			if (dueForSample || history.length === 0) {
				if (stableTemp === null) {
					logging("Venter på stabil temperatur for " + id + ", råverdi: " + rawTemp);
				} else {
					if (dueForSample && reloadIn <= 0) {
						reloadIn = newTempValues;
					}
					var hum = state.lastStableHum != null ? state.lastStableHum : rawHum;
					logging("Legger til måling for " + labelForSensor(id));
					pushHistory(id, stableTemp, hum, currentDate);
				}
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

app.get('/sensor/next', function (req, res) {
	stepSensor(1);
	res.redirect('/');
});

app.get('/sensor/prev', function (req, res) {
	stepSensor(-1);
	res.redirect('/');
});

app.get('/temperaturer', (req, res) => {
	const series = currentSeries();
	const data = [];
	for (let i = 0; i < series.length; i++) {
	  var element = {};
	  element.temp = series[i][0];
	  element.time = series[i][1];
	  element.hum = series[i][2];
	  element.date = series[i][3];
	  data.push(element);
	}
	//data = [{ "temp": "22.5", "time": "18:10" },{"temp":"22.4", "time":"18:15"}]; // Example
  	res.json(data);
});

app.get('/', function (req, res) {
	res.render('index', sensorView())
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
                    var rawTemp = dataValue(values.data, "temp", 0);
                    if (rawTemp !== undefined) {
                        var id = String(values.id != null ? values.id : element.id);
                        var state = ensureSensor(id);
                        state.name = values.name || "";
                        state.model = values.model || "";
                        syncSensorOrder();
                        var rawHum = dataValue(values.data, "humidity", 1);
                        logging("Funnet sensor " + id + ", legger til i grafarray");
                        logging("Full metering data:" + JSON.stringify(values));
                        pushHistory(id, rawTemp, rawHum, currentDate);
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
