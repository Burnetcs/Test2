/* eslint-disable max-len, no-useless-return */
const Utils = require("../Modules/Utils/");
const {
	Gist,
	FilterChecker: checkFiltered,
} = Utils;

module.exports = async (bot, db, configJS, configJSON, msg) => {

	// Reload commands, dumb idea but whatever
	// TODO: Can we remove this after we are sure everything works?
	// Put it in ready or something
	bot.reloadAllCommands();

	const chatterPrompt = async (userID, prompt) => {
		let res;
		try {
			res = await rp.get({
				uri: `http://api.program-o.com/v2/chatbot/`,
				qs: {
					bot_id: 6,
					say: encodeURIComponent(prompt),
					convo_id: userID,
					format: "json",
				},
				headers: {
					Accept: "application/json",
					"User-Agent": "GAwesomeBot (https://gawesomebot.com)",
				},
			});
		} catch (err) {
			throw err;
		}
		let response;
		if (res.statusCode === 200 && res.body) {
			response = JSON.parse(res.body).botsay
				.replaceAll("Program-O", bot.user.username)
				.replaceAll("<br/>", "\n")
				.replaceAll("Elizabeth", "BitQuote");
		} else {
			response = "I don't feel like talking right now.. 😠";
		}
		return response;
	};

	// Stop responding if user is a bot or is globally blocked
	if (msg.author.id === bot.user.id || msg.author.bot || configJSON.globalBlockList.includes(msg.author.id)) {
		if (msg.author.id === bot.user.id) {
			// Actually do nothing top keke
		} else {
			winston.silly(`Ignored ${msg.author.tag}.`, { usrid: msg.author.id });
		}
		// Handle private messages
	} else if (!msg.guild) {
		// Forward PM to maintainer(s) if enabled
		if (!configJSON.maintainers.includes(msg.author.id) && configJSON.pmForward) {
			let url = "";
			if (msg.cleanContent.length >= 1950) {
				const GistUpload = new Gist(bot);
				const res = await GistUpload.upload({
					title: "Bot DM",
					text: msg.cleanContent,
				});
				if (res.url) {
					url = res.url;
				}
			}
			for (const maintainerID of configJSON.maintainers) {
				let user = bot.users.get(maintainerID);
				if (!user) {
					user = await bot.fetchUser(maintainerID, false); // eslint-disable-line no-await-in-loop
				}
				user.send({
					embed: {
						color: 0x3669FA,
						author: {
							name: `${msg.author.tag} just sent me a PM!`,
							icon_url: msg.author.displayAvatarURL,
						},
						description: `${url !== "" ? `The message was too large! Please go [here](${url}) to read it. 📨` : `\`\`\`${msg.cleanContent}\`\`\``}`,
					},
				});
			}
		}
		let command = msg.content.toLowerCase().trim();
		let suffix = "";
		if (command.includes(" ")) {
			command = command.substring(0, command.indexOf(" "));
			suffix = msg.content.substring(msg.content.indexOf(" ") + 1).trim();
		}
		const command_func = bot.getPMCommand(command);
		if (command_func) {
			winston.info(`Treating "${msg.cleanContent}" as a PM command`, { usrid: msg.author.id, cmd: command });
			const findDocument = await db.users.findOrCreate({ _id: msg.author.id }).catch(err => {
				winston.error("Failed to find or create user data for message", { usrid: msg.author.id }, err);				
			});
			const userDocument = findDocument.doc;
			try {
				await command_func({
					bot,
					db,
					configJS,
					configJSON,
					utils: Utils,
					Utils,
				}, userDocument, msg, suffix, {
					name: command,
					usage: bot.getPMCommandMetadata(command).usage,
				});
			} catch (err) {
				winston.error(`Failed to process PM command "${command}"`, { usrid: msg.author.id }, err);
				msg.author.send({
					embed: {
						color: 0xFF0000,
						title: `Something went wrong! 😱`,
						description: `**Error Message**: \`\`\`js\n${err.stack}\`\`\``,
						footer: {
							text: `You should report this on GitHub so we can fix it!`,
						},
					},
				});
			}
		} else {
			// Process chatterbot prompt
			winston.info(`Treating "${msg.cleanContent}" as a PM chatterbot prompt`, { usrid: msg.author.id });
			const m = await msg.channel.send({
				embed: {
					color: 0x3669FA,
					description: `The chatter bot is thinking...`,
				},
			});
			const response = await chatterPrompt(msg.author.id, msg.cleanContent);
			await m.edit({
				embed: {
					title: `The Program-O Chatter Bot replied with:`,
					url: `https://program-o.com`,
					description: response,
					thumbnail: {
						url: `https://cdn.program-o.com/images/program-o-luv-bunny.png`,
					},
					color: 0x00FF00,
				},
			});
		}
	} else {
		// Handle public messages
		const serverDocument = await db.servers.findOne({ _id: msg.guild.id }).exec().catch(err => {
			winston.warn("Failed to find server data for message", { svrid: msg.channel.guild.id, chid: msg.channel.id, usrid: msg.author.id }, err);
		});
		if (serverDocument) {
			// Get channel data
			let channelDocument = serverDocument.channels.id(msg.channel.id);
			// Create channel data if not found
			if (!channelDocument) {
				serverDocument.channels.push({ _id: msg.channel.id });
				channelDocument = serverDocument.channels.id(msg.channel.id);
			}
			// Get member data (for this server)
			let memberDocument = serverDocument.members.id(msg.author.id);
			// Create member data if not found
			if (!memberDocument) {
				serverDocument.members.push({ _id: msg.author.id });
				memberDocument = serverDocument.members.id(msg.author.id);
			}
			const memberBotAdminLevel = bot.getUserBotAdmin(msg.guild, serverDocument, msg.member);
			// Increment today's message count for server
			serverDocument.messages_today++;
			// Count server stats if enabled in this channel
			if (channelDocument.isStatsEnabled) {
				// Increment this week's message count for member
				memberDocument.messages++;
				// Set now as the last active time for member
				memberDocument.last_active = Date.now();
				// Check if the user has leveled up a rank
				await bot.checkRank(msg.guild, serverDocument, msg.member, memberDocument);
				// Save changes to serverDocument
				await serverDocument.save().catch(err => {
					winston.warn(`Failed to save server data for MESSAGE`, { svrid: msg.guild.id }, err);
				});
			}

			// Check for start command from server admin
			if (!channelDocument.bot_enabled && memberBotAdminLevel > 1) {
				const startCommand = await bot.checkCommandTag(msg.content, serverDocument);
				if (startCommand && startCommand.command === "start") {
					channelDocument.bot_enabled = true;
					let inAllChannels = false;
					if (startCommand.suffix.toLowerCase().trim() === "all") {
						inAllChannels = true;
						serverDocument.channels.forEach(targetChannelDocument => {
							targetChannelDocument.bot_enabled = true;
						});
					}
					await serverDocument.save().catch(err => {
						winston.warn(`Failed to save server data for bot enable..`, { svrid: msg.guild.id }, err);
					});
					msg.channel.send({
						embed: {
							color: 0x3669FA,
							description: `Hello! I'm back${inAllChannels ? "in all channels" : ""}! 🐬`,
						},
					});
					return;
				}
			}

			// Check if using a filtered word
			if (checkFiltered(serverDocument, msg.channel, msg.cleanContent, false, true)) {
				// Delete offending message if necessary
				if (serverDocument.config.moderation.filters.custom_filter.delete_message) {
					try {
						await msg.delete();
					} catch (err) {
						winston.debug(`Failed to delete filtered mesage from member "${msg.author.tag}" in channel ${msg.channel.name} on server "${msg.guild}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id }, err);
					}
				}
				// Get user data
				const findDocument = await db.users.findOrCreate({ _id: msg.author.id }).catch(err => {
					winston.error("Failed to find or create user data for message filter violation", { usrid: msg.author.id }, err);						
				});
			}
		}
	}
};