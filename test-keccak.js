const { ethers } = require('ethers');
const addr = '0000000000000000000000000000000000000000';
const nonceSlot = '90d9448a3655c63c0492145a86bdec6cb2014b2d48ac5442de443d4dabd1f2f8';
const combined = addr + nonceSlot;
console.log('keccak256 result:', ethers.keccak256(Buffer.from(combined, 'hex')));
console.log('expected: 0x7e7a866d8000c2ba02d4471c6605e53fcf5b47c44b1f725fe0e84b1ca1dd4787');
