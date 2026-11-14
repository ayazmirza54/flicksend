// Learn more https://docs.expo.dev/guides/customizing-metro
const {getDefaultConfig} = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);

// Shared protocol code lives outside this app folder.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../../shared')];

module.exports = config;
