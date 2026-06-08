const databaseName = process.env.MONGO_INITDB_DATABASE || 'dcp';
const applicationUsername = process.env.MONGO_APP_USERNAME;
const applicationPassword = process.env.MONGO_APP_PASSWORD;

if (!applicationUsername || !applicationPassword) {
  throw new Error('Thiếu MONGO_APP_USERNAME hoặc MONGO_APP_PASSWORD để tạo MongoDB application user.');
}

const applicationDatabase = db.getSiblingDB(databaseName);

// Logic này chỉ chạy khi volume MongoDB được khởi tạo lần đầu, giúp backend dùng user ít quyền hơn root.
applicationDatabase.createUser({
  user: applicationUsername,
  pwd: applicationPassword,
  roles: [
    {
      role: 'readWrite',
      db: databaseName
    }
  ]
});
