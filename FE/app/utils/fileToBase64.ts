/** Chuyển một file trình duyệt thành base64 payload để gửi qua JSON API. */
export function convertFileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = () => {
      const readerResult = fileReader.result;
      if (typeof readerResult !== 'string') {
        reject(new Error('Không thể đọc nội dung file upload.'));
        return;
      }

      const base64Content = readerResult.includes(',')
        ? readerResult.slice(readerResult.indexOf(',') + 1)
        : readerResult;
      resolve(base64Content);
    };
    fileReader.onerror = () => reject(new Error('Không thể đọc nội dung file upload.'));
    fileReader.readAsDataURL(file);
  });
}

