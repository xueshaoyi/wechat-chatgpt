async function sendMsg(data: string): Promise<void> {
    const url = 'http://127.0.0.1:8080/message';
    const headers = {
      'Content-Type': 'text/plain'
    };
  
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: data
      });
  
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
  
      const responseData = await response.text(); // 或者 response.json() 如果响应是JSON
      console.log(responseData);
    } catch (error) {
      console.error('Error:', error);
    }
  }

export {sendMsg};