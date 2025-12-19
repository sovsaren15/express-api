const jwt = require("jsonwebtoken")

module.exports = (allowedRoles = []) => {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1]

    if (!token) {
      return res.status(401).json({ error: "No token provided" })
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      req.user = decoded

      if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ error: "Insufficient permissions" })
      }

      next()
    } catch (err) {
      return res.status(401).json({ error: "Invalid token" })
    }
  }
}
