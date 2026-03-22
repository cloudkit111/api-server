import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    fullname: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true
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
            }
        }
    ]
}, {
    timestamps: true
})

export const User = mongoose.model('User', userSchema);