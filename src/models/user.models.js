import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  fullname: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true   // 🔥 IMPORTANT (no duplicate users)
  },
  repos: [
    {
      name: {
        type: String,
        required: true
      },
      clone_url: {
        type: String,
        required: true
      },
      private: {
        type: Boolean,
        required: true
      },
      Projects:[{
         project_url : {type:String},
         slug:{type:String},
         repoName : {type:String},
      }],
      created_at: {
        type: Date
      }
    }
  ]
}, {
  timestamps: true
});

export const User = mongoose.model("User", userSchema);
