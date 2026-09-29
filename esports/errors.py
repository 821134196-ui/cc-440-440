"""业务异常: 携带 HTTP 状态码与机器可读的错误码。"""


class BizError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
