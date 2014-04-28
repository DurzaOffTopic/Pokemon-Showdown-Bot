﻿/**
 * This is the file where commands get parsed
 *
 * Some parts of this code are taken from the Pokémon Showdown server code, so
 * credits also go to Guangcong Luo and other Pokémon Showdown contributors.
 * https://github.com/Zarel/Pokemon-Showdown
 *
 * @license MIT license
 */

var sys = require('sys');
var https = require('https');
var url = require('url');

settings = {};
try {
	settings = JSON.parse(fs.readFileSync('settings.json'));
	if (!Object.keys(settings).length && settings !== {}) settings = {};
} catch (e) {} // file doesn't exist [yet]

exports.parse = {
	actionUrl: url.parse('https://play.pokemonshowdown.com/~~' + config.serverid + '/action.php'),
	room: 'lobby',
	'settings': settings,
	chatData: {},
	ranks: {},

	data: function(data, connection) {
		if (data.substr(0, 1) === 'a') {
			data = JSON.parse(data.substr(1));
			if (data instanceof Array) {
				for (var i = 0; i < data.length; i++) {
					this.message(data[i], connection);
				}
			} else {
				this.message(data, connection);
			}
		}
	},
	message: function(message, connection) {
		if (!message) return;

		if (message.indexOf('\n') > -1) {
			var spl = message.split('\n');
			for (var i = 0; i < spl.length; i++) {
				if (spl[i].split('|')[1] && (spl[i].split('|')[1] === 'init' || spl[i].split('|')[1] === 'tournament')) {
					this.room = '';
					break;
				}
				this.message(spl[i], connection);
			}
			return;
		}

		var spl = message.split('|');
		if (!spl[1]) {
			spl = message.split('>');
			if (!spl[1])
				return;
			this.room = spl[1];
		}

		switch (spl[1]) {
			case 'challstr':
				info('received challstr, logging in...');
				var id = spl[2];
				var str = spl[3];

				var requestOptions = {
					hostname: this.actionUrl.hostname,
					port: this.actionUrl.port,
					path: this.actionUrl.pathname,
					agent: false
				};

				if (!config.pass) {
					requestOptions.method = 'GET';
					requestOptions.path += '?act=getassertion&userid=' + toId(config.nick) + '&challengekeyid=' + id + '&challenge=' + str;
				} else {
					requestOptions.method = 'POST';
					var data = 'act=login&name=' + config.nick + '&pass=' + config.pass + '&challengekeyid=' + id + '&challenge=' + str;
					requestOptions.headers = {
						'Content-Type': 'application/x-www-form-urlencoded',
						'Content-Length': data.length
					};
				}

				var req = https.request(requestOptions, function(res) {
					res.setEncoding('utf8');
					var data = '';
					res.on('data', function(chunk) {
						data += chunk;
					});
					res.on('end', function() {
						if (data === ';') {
							error('failed to log in; nick is registered - invalid or no password given');
							process.exit(-1);
						}
						if (data.length < 50) {
							error('failed to log in: ' + data);
							process.exit(-1);
						}

						if (data.indexOf('heavy load') !== -1) {
							error('the login server is under heavy load; trying again in one minute');
							setTimeout(function() {
								this.message(message);
							}.bind(this), 60000);
							return;
						}

						try {
							data = JSON.parse(data.substr(1));
							if (data.actionsuccess) {
								data = data.assertion;
							} else {
								error('could not log in; action was not successful: ' + JSON.stringify(data));
								process.exit(-1);
							}
						} catch (e) {}
						send(connection, '|/trn ' + config.nick + ',0,' + data);
					}.bind(this));
				}.bind(this));
				
				req.on('error', function(err) {
					error('login error: ' + sys.inspect(err));
				});
				
				if (data) {
					req.write(data);
				}
				req.end();
				break;
			case 'updateuser':
				if (spl[2] !== config.nick) {
					return;
				}

				if (spl[3] !== '1') {
					error('failed to log in, still guest');
					process.exit(-1);
				}

				ok('logged in as ' + spl[2]);

				// Now join the rooms
				var cmds = ['/idle'];
				for (var i in config.rooms) {
					var room = toId(config.rooms[i]);
					if (room === 'lobby' && config.serverid === 'showdown') {
						continue;
					}
					cmds.push('|/join ' + room);
				}
				for (var i in config.privaterooms) {
					var room = toId(config.privaterooms[i]);
					if (room === 'lobby' && config.serverid === 'showdown') {
						continue;
					}
					cmds.push('|/join ' + room);
				}

				var self = this;
				if (cmds.length > 6) {
					self.nextJoin = 0;
					self.joinSpacer = setInterval(function(con, cmds) {
						if (cmds.length > self.nextJoin + 5) {
							send(con, cmds.slice(self.nextJoin, self.nextJoin + 5));
							self.nextJoin += 5;
						} else {
							send(con, cmds.slice(self.nextJoin));
							delete self.nextJoin;
							clearInterval(self.joinSpacer);
						}
					}, 8*1000, connection, cmds);
				} else {
					send(connection, cmds);
				}

				this.chatDataTimer = setInterval(
					function() {self.chatData = cleanChatData(self.chatData);},
					30*60*1000
				);
				this.room = '';
				break;
			case 'title':
				ok('joined ' + spl[2]);
				this.room = '';
				break;
			case 'c':
				var by = spl[2];
				spl.splice(0, 3);
				this.processChatData(by, this.room || 'lobby', connection, spl.join('|'));
				this.chatMessage(spl.join('|'), by, this.room || 'lobby', connection);
				this.room = '';
				break;
			case 'pm':
				var by = spl[2];
				if (by.substr(1) === config.nick) return;
				spl.splice(0, 4);
				this.chatMessage(spl.join('|'), by, ',' + by, connection);
				this.room = '';
				break;
			case 'N':
				var by = spl[2];
				this.updateSeen(spl[3], spl[1], by);
				this.room = '';
				break;
			case 'J': case 'j':
				var by = spl[2];
				this.updateSeen(by, spl[1], (this.room === ''?'lobby':this.room));
				if (by.substr(1) !== config.nick || ' +%@&#~'.indexOf(by.charAt(0)) === -1) return;
				this.ranks[(this.room === ''?'lobby':this.room)] = by.charAt(0);
				this.room = '';
				break;
			case 'l': case 'L':
				var by = spl[2];
				this.updateSeen(by, spl[1], (this.room === ''?'lobby':this.room));
				this.room = '';
				break;
		}
	},
	chatMessage: function(message, by, room, connection) {
		message = message.trim();
		if (message.substr(0, config.commandcharacter.length) !== config.commandcharacter || toId(by) === toId(config.nick)) {
			return;
		}

		message = message.substr(config.commandcharacter.length);
		var index = message.indexOf(' ');
		var arg = '';
		if (index > -1) {
			var cmd = message.substr(0, index);
			arg = message.substr(index + 1).trim();
		} else {
			var cmd = message;
		}

		if (Commands[cmd]) {
			var failsafe = 0;
			while (typeof Commands[cmd] !== "function" && failsafe++ < 10) {
				cmd = Commands[cmd];
			}
			if (typeof Commands[cmd] === "function") {
				Commands[cmd].call(this, arg, by, room, connection);
			} else {
				error("invalid command type for " + cmd + ": " + (typeof Commands[cmd]));
			}
		}
		
		// auto accept invitations to rooms
		if (room.charAt(0) === ',' && message.substr(0,8) === '/invite ' && !(config.serverid === 'showdown' && toId(message.substr(8)) === 'lobby')) {
			this.say(connection, '', '/join ' + message.substr(8));
		}
	},
	say: function(connection, room, text) {
		if (room.substr(0, 1) !== ',') {
			var str = (room !== 'lobby' ? room : '') + '|' + text;
			send(connection, str);
		} else {
			room = room.substr(1);
			var str = '|/pm ' + room + ', ' + text;
			send(connection, str);
		}
	},
	hasRank: function(user, rank) {
		var hasRank = (rank.split('').indexOf(user.charAt(0)) !== -1) || (config.excepts.indexOf(toId(user.substr(1))) !== -1);
		return hasRank;
	},
	canUse: function(cmd, room, user) {
		var canUse = false;
		var ranks = ' +%@&#~';
		if (!this.settings[cmd] || !(room in this.settings[cmd])) {
			canUse = this.hasRank(user, ranks.substr(ranks.indexOf(config.defaultrank)));
		} else if (this.settings[cmd][room] === true) {
			canUse = true;
		} else if (ranks.indexOf(this.settings[cmd][room]) > -1) {
			canUse = this.hasRank(user, ranks.substr(ranks.indexOf(this.settings[cmd][room])));
		}
		return canUse;
	},
	processChatData: function(user, room, connection, msg) {
		// NOTE: this is still in early stages
		user = toId(user);
		if (room.charAt(0) === ',' || user === toId(config.nick)) return;
		room = toId(room);
		msg = msg.trim().replace(/ +/g, " ");
		this.updateSeen(user, 'c', room);
		if (!this.chatData[user][room]) this.chatData[user][room] = {times:[], points:0, lastAction:0};

		this.chatData[user][room].times.push(Date.now());

		// this deals with punishing rulebreakers, but note that the bot can't think, so it might make mistakes
		if (config.allowmute && this.hasRank(this.ranks[room] || ' ', '%@&#~')) {
			var useDefault = !(this.settings['modding'] && this.settings['modding'][room]);
			var pointVal = 0;
			var muteMessage = '';

			var snenMatch = msg.toLowerCase().match(/snen/g);
			if ((useDefault || this.settings['modding'][room]['snen'] !== false) && snenMatch && snenMatch.length > 6) {
				if (pointVal < 4) {
					muteMessage = ', Automated response: possible "snen" spammer';
					pointVal = (room === 'lobby') ? 5 : 4;
				}
			}
			var isFlooding = (this.chatData[user][room].times.length >= 5 && (Date.now() - this.chatData[user][room].times[this.chatData[user][room].times.length - 5]) < 6*1000);
			if ((useDefault || this.settings['modding'][room]['flooding'] !== false) && isFlooding) {
				if (pointVal < 2) {
					pointVal = 2;
					muteMessage = ', Automated response: flooding';
				}
			}
			var capsMatch = msg.replace(/[^A-Za-z]/g, '').match(/[A-Z]/g);
			if ((useDefault || this.settings['modding'][room]['caps'] !== false) && capsMatch && toId(msg).length > 18 && (capsMatch.length >= Math.floor(toId(msg).length * 0.8))) {
				if (pointVal < 1) {
					pointVal = 1;
					muteMessage = ', Automated response: caps';
				}
			}
			var stretchMatch = msg.toLowerCase().match(/(.)\1{7,}/g); // matches the same character 8 or more times in a row
			if ((useDefault || this.settings['modding'][room]['stretching'] !== false) && stretchMatch) {
				if (pointVal < 1) {
					pointVal = 1;
					muteMessage = ', Automated response: stretching';
				}
			}

			if (pointVal > 0 && !(Date.now() - this.chatData[user][room].lastAction < 3*1000)) {
				var cmd = 'mute';
				if (this.chatData[user][room].points >= pointVal && pointVal < 4) {
					this.chatData[user][room].points++;
					cmd = config.punishvals[this.chatData[user][room].points] || cmd;
				} else {
					cmd = config.punishvals[pointVal] || cmd;
					this.chatData[user][room].points = pointVal;
				}
				if (config.privaterooms.indexOf(room) >= 0 && cmd === 'warn') cmd = 'mute';
				if (this.chatData[user][room].points >= 4 && !this.hasRank(this.ranks[room] || ' ', '@&#~')) cmd = 'hourmute';
				if (this.chatData[user].zeroTol > 4) {
					muteMessage = ', Automated response: zero tolerance user';
					cmd = this.hasRank(this.ranks[room] || ' ', '@&#~') ? 'roomban' : 'hourmute';
				}
				if (this.chatData[user][room].points >= 2) this.chatData[user].zeroTol++;
				this.chatData[user][room].lastAction = Date.now();
				this.say(connection, room, '/' + cmd + ' ' + user + muteMessage);
			}
		}
	},
	updateSeen: function(user, type, detail) {
		user = toId(user);
		type = toId(type);
		var time = Date.now();
		if (!this.chatData[user]) this.chatData[user] = {
			zeroTol: 0,
			lastSeen: '',
			seenAt: time
		};
		if (!detail) return;
		var msg = '';
		if (type in {j:1, l:1, c:1}) {
			if (config.rooms.indexOf(toId(detail)) === -1 || config.privaterooms.indexOf(toId(detail)) > -1) return;
			msg += (type === 'j' ? 'joining' : (type === 'l' ? 'leaving' : 'chatting in')) + ' ' + detail.trim() + '.';
		} else if (type === 'n') {
			msg += 'changing nick to ' + ('+%@&#~'.indexOf(detail.trim().charAt(0)) === -1 ? detail.trim() : detail.trim().substr(1)) + '.';
		}
		this.chatData[user].lastSeen = msg;
		this.chatData[user].seenAt = time;
	},
	getTimeAgo: function(time) {
		time = Date.now() - time;
		time = Math.round(time/1000); // rounds to nearest second
		var seconds = time%60;
		var times = [];
		if (seconds) times.push(String(seconds) + (seconds === 1?' second':' seconds'));
		var minutes, hours, days;
		if (time >= 60) {
			time = (time - seconds)/60; // converts to minutes
			minutes = time%60;
			if (minutes) times = [String(minutes) + (minutes === 1?' minute':' minutes')].concat(times);
			if (time >= 60) {
				time = (time - minutes)/60; // converts to hours
				hours = time%24;
				if (hours) times = [String(hours) + (hours === 1?' hour':' hours')].concat(times);
				if (time >= 24) {
					days = (time - hours)/24; // you can probably guess this one
					if (days) times = [String(days) + (days === 1?' day':' days')].concat(times);
				}
			}
		}
		if (!times.length) times.push('0 seconds');
		return times.join(', ');
	},
	uncacheTree: function(root) {
		var uncache = [require.resolve(root)];
		do {
			var newuncache = [];
			for (var i = 0; i < uncache.length; ++i) {
				if (require.cache[uncache[i]]) {
					newuncache.push.apply(newuncache,
						require.cache[uncache[i]].children.map(function(module) {
							return module.filename;
						})
					);
					delete require.cache[uncache[i]];
				}
			}
			uncache = newuncache;
		} while (uncache.length > 0);
	}
};
